import { resolveConfig, type Config, type ResolvedNode } from "@ephor/core";
import type { ProbeRegistry } from "./probes/registry.js";
import { Scheduler, type Task } from "./scheduling/scheduler.js";
import { TaskExecutor } from "./scheduling/task-executor.js";
import { systemClock } from "./scheduling/clock.js";

export interface CollectorOptions {
  config: Config;
  registry: ProbeRegistry;
  storage: Storage;
}

export class Collector {
  private readonly scheduler: Scheduler;
  private readonly taskExecutor: TaskExecutor;
  private readonly resolvedNodes: ResolvedNode[];

  constructor(private readonly options: CollectorOptions) {
    const probeNames = options.registry.names();
    this.resolvedNodes = resolveConfig(options.config, probeNames);

    this.scheduler = new Scheduler({
      clock: systemClock,
      onTasksDue: (tasks) => this.taskExecutor.submit(tasks),
    });

    this.taskExecutor = new TaskExecutor({
      concurrencyByProbe: buildConcurrencyMap(options.config),
      defaultConcurrency: 8,
      handler: (task) => this.runProbe(task),
      onTaskFinished: (task) => this.scheduler.complete(task),
    });

    this.scheduler.setNodes(this.resolvedNodes);
  }

  private runProbe(task: Task): Promise<void> {}
}

function buildConcurrencyMap(config: Config): ReadonlyMap<string, number> {
  const map = new Map<string, number>();

  for (const [probeName, settings] of Object.entries(config.probes)) {
    map.set(probeName, settings.concurrency);
  }

  return map;
}
