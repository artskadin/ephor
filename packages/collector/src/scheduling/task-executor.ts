import { ProbeSettingsSchema } from "@ephor/core";
import { ConcurrencyLimiter } from "./concurrency-limiter.js";
import type { Task } from "./scheduler.js";

export type TaskHandler = (task: Task) => Promise<void>;

export interface TaskExecutorOptions {
  concurrencyByProbe: ReadonlyMap<string, number>;
  defaultConcurrency: number;
  handler: TaskHandler;
  onTaskFinished: (task: Task) => void;
}

export class TaskExecutor {
  private readonly limiterByProbe = new Map<string, ConcurrencyLimiter>();

  constructor(private readonly options: TaskExecutorOptions) {}

  submit(tasks: readonly Task[]): void {
    for (const task of tasks) {
      const limiter = this.limiterFor(task.probe);

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

  private limiterFor(probeName: string): ConcurrencyLimiter {
    let limiter = this.limiterByProbe.get(probeName);

    if (!limiter) {
      const limit =
        this.options.concurrencyByProbe.get(probeName) ??
        this.options.defaultConcurrency;

      limiter = new ConcurrencyLimiter(limit);

      this.limiterByProbe.set(probeName, limiter);
    }

    return limiter;
  }
}
