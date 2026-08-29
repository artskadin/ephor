import { ConcurrencyLimiter } from "./concurrency-limiter.js";
import type { Task } from "./scheduler.js";

export type TaskHandler = (task: Task) => Promise<void>;

export interface TaskExecutorOptions {
  concurrencyByProbe: ReadonlyMap<string, number>;
  handler: TaskHandler;
  onTaskFinished: (task: Task) => void;
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
        console.error(
          `No concurrency limit configured for probe "${task.probe}"; ` +
            `skipping task for node "${task.node.node.name}"`,
        );
        this.options.onTaskFinished(task);
        continue;
      }

      void limiter
        .run(() => this.options.handler(task))
        .catch((err: unknown) => {
          console.error(
            `Unhandled error in probe "${task.probe}" ` +
              `for node "${task.node.node.name}"`,
            err,
          );
        })
        .finally(() => this.options.onTaskFinished(task));
    }
  }

  stats(): Record<string, { active: number; pending: number }> {
    const result: Record<string, { active: number; pending: number }> = {};

    for (const [probName, limiter] of this.limiterByProbe) {
      result[probName] = { active: limiter.active, pending: limiter.pending };
    }

    return result;
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
