import type { Logger } from "@ephor/core";
import { ConcurrencyLimiter } from "./concurrency-limiter.js";
import type { Task } from "./scheduler.js";

export type TaskHandler = (task: Task) => Promise<void>;

export interface QueueState {
  /** Runs holding a slot right now. */
  active: number;
  /** Runs waiting for a slot to free up. */
  queued: number;
  /** Slots: the probe's concurrency. */
  limit: number;
}

export interface TaskExecutorOptions {
  concurrencyByProbe: ReadonlyMap<string, number>;
  handler: TaskHandler;
  onTaskFinished: (task: Task) => void;
  logger: Logger;
}

export class TaskExecutor {
  private readonly limiterByProbe = new Map<string, ConcurrencyLimiter>();

  constructor(private readonly options: TaskExecutorOptions) {}

  submit(tasks: readonly Task[]): void {
    for (const task of tasks) {
      const limiter = this.limiterFor(task.probe);

      // Loud, but not fatal: submit() runs inside the scheduler's interval
      // callback, so throwing here would take the whole collector down and
      // leave the task marked in flight forever, silencing that node/probe
      // pair for good. Report it and let the rest of the batch through.
      if (!limiter) {
        this.options.logger.error("no concurrency limit for probe, skipping", {
          probe: task.probe,
          node: task.node.node.name,
        });
        this.options.onTaskFinished(task);
        continue;
      }

      void limiter
        .run(() => this.options.handler(task))
        .catch((cause: unknown) => {
          this.options.logger.error("unhandled error while running a probe", {
            probe: task.probe,
            node: task.node.node.name,
            cause,
          });
        })
        .finally(() => this.options.onTaskFinished(task));
    }
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

    const limiter = this.limiterByProbe.get(probeName);

    return {
      active: limiter?.active ?? 0,
      queued: limiter?.pending ?? 0,
      limit,
    };
  }

  /** Undefined when the task names a probe nobody registered. */
  private limiterFor(probeName: string): ConcurrencyLimiter | undefined {
    let limiter = this.limiterByProbe.get(probeName);

    if (!limiter) {
      const limit = this.options.concurrencyByProbe.get(probeName);

      if (limit === undefined) return undefined;

      limiter = new ConcurrencyLimiter(limit);

      this.limiterByProbe.set(probeName, limiter);
    }

    return limiter;
  }
}
