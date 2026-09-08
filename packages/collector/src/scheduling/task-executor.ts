import type { Logger, QueueState } from "@ephorate/core";
import { BacklogDetector } from "./backlog-detector.js";
import { ConcurrencyLimiter } from "./concurrency-limiter.js";
import type { Task } from "./scheduler.js";

export type TaskHandler = (task: Task) => Promise<void>;

export interface TaskExecutorOptions {
  concurrencyByProbe: ReadonlyMap<string, number>;
  handler: TaskHandler;
  onTaskFinished: (task: Task) => void;
  logger: Logger;
}

/** One probe's queue: its limiter, and the watch that says when it is behind. */
interface ProbeQueue {
  limiter: ConcurrencyLimiter;
  backlog: BacklogDetector;
}

export class TaskExecutor {
  private readonly queueByProbe = new Map<string, ProbeQueue>();

  constructor(private readonly options: TaskExecutorOptions) {}

  submit(tasks: readonly Task[]): void {
    const touched = new Set<ProbeQueue>();

    for (const task of tasks) {
      const queue = this.queueFor(task.probe);

      // Loud, but not fatal: submit() runs inside the scheduler's interval
      // callback, so throwing here would take the whole collector down and
      // leave the task marked in flight forever, silencing that node/probe
      // pair for good. Report it and let the rest of the batch through.
      if (!queue) {
        this.options.logger.error("no concurrency limit for probe, skipping", {
          probe: task.probe,
          node: task.node.node.name,
        });
        this.options.onTaskFinished(task);
        continue;
      }

      void queue.limiter
        .run(() => this.options.handler(task))
        .catch((cause: unknown) => {
          this.options.logger.error("unhandled error while running a probe", {
            probe: task.probe,
            node: task.node.node.name,
            cause,
          });
        })
        .finally(() => {
          // The limiter has already handed the freed slot to the next in
          // line, so this reads the queue as it now stands.
          queue.backlog.observe(queue.limiter.state());
          this.options.onTaskFinished(task);
        });

      touched.add(queue);
    }

    // Once per batch rather than per task: a fleet forced at once arrives as
    // one batch, and the line should carry the whole count, not the first
    // crossing of the bar. The limiter takes or queues a place synchronously,
    // so the counts are complete here.
    for (const queue of touched) queue.backlog.observe(queue.limiter.state());
  }

  /**
   * How busy one probe's queue is. Undefined when the probe has no limit,
   * which means nobody registered it; a registered probe that has not run
   * yet reports an empty queue, since its limiter exists only from the first
   * task on.
   */
  queueOf(probeName: string): QueueState | undefined {
    const limit = this.options.concurrencyByProbe.get(probeName);

    if (limit === undefined) return undefined;

    return this.stateOf(probeName, limit);
  }

  /** Every registered probe's queue, the ones that have not run yet included. */
  queues(): ReadonlyMap<string, QueueState> {
    const queues = new Map<string, QueueState>();

    for (const [probe, limit] of this.options.concurrencyByProbe) {
      queues.set(probe, this.stateOf(probe, limit));
    }

    return queues;
  }

  private stateOf(probeName: string, limit: number): QueueState {
    return (
      this.queueByProbe.get(probeName)?.limiter.state() ?? {
        active: 0,
        queued: 0,
        limit,
      }
    );
  }

  /** Undefined when the task names a probe nobody registered. */
  private queueFor(probeName: string): ProbeQueue | undefined {
    let queue = this.queueByProbe.get(probeName);

    if (!queue) {
      const limit = this.options.concurrencyByProbe.get(probeName);

      if (limit === undefined) return undefined;

      queue = {
        limiter: new ConcurrencyLimiter(limit),
        backlog: new BacklogDetector({
          subject: probeName,
          logger: this.options.logger.child({ probe: probeName }),
        }),
      };

      this.queueByProbe.set(probeName, queue);
    }

    return queue;
  }
}
