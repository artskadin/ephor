import type { Logger, QueueState } from "@ephorate/core";
import { BacklogDetector } from "./backlog-detector";
import { ConcurrencyLimiter } from "./concurrency-limiter";
import type { Task } from "./scheduler";

interface TaskExecutorOptions {
  concurrencyByProbe: ReadonlyMap<string, number>;
  handler: (task: Task) => Promise<void>;
  onTaskFinished: (task: Task) => void;
  logger: Logger;
}

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

      // Not thrown: this runs inside the scheduler's interval callback, and
      // a throw would leave the task in flight forever.
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
          queue.backlog.observe(queue.limiter.state());
          this.options.onTaskFinished(task);
        });

      touched.add(queue);
    }

    // Once per batch, so a fleet forced at once is logged with its whole count.
    for (const queue of touched) queue.backlog.observe(queue.limiter.state());
  }

  /** Undefined for a probe nobody registered. */
  queueState(probeName: string): QueueState | undefined {
    const limit = this.options.concurrencyByProbe.get(probeName);

    if (limit === undefined) return undefined;

    return this.queueStateOrIdle(probeName, limit);
  }

  /** Every registered probe, the ones that have not run yet included. */
  queues(): ReadonlyMap<string, QueueState> {
    const queues = new Map<string, QueueState>();

    for (const [probe, limit] of this.options.concurrencyByProbe) {
      queues.set(probe, this.queueStateOrIdle(probe, limit));
    }

    return queues;
  }

  private queueStateOrIdle(probeName: string, limit: number): QueueState {
    return (
      this.queueByProbe.get(probeName)?.limiter.state() ?? {
        active: 0,
        queued: 0,
        limit,
      }
    );
  }

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
