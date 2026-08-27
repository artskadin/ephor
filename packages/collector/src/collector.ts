import {
  resolveConfig,
  type Config,
  type MetricPoint,
  type ProbeContext,
  type ProbeError,
  type ResolvedNode,
  type Storage,
} from "@ephor/core";
import type { ProbeRegistry } from "./probes/registry.js";
import { Scheduler, type Task } from "./scheduling/scheduler.js";
import { TaskExecutor } from "./scheduling/task-executor.js";
import { systemClock } from "./scheduling/clock.js";
import { createExecutor } from "./execution/create-executor.js";

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

  async start(): Promise<void> {
    await this.options.storage.migrate();

    this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
  }

  runNow(nodeName?: string, probeName?: string): void {
    this.scheduler.runNow(nodeName, probeName);
  }

  private async runProbe(task: Task): Promise<void> {
    const probe = this.options.registry.get(task.probe);
    const check = task.node.checks.get(task.probe);

    if (!probe || !check) return;

    const node = task.node.node;
    const timeoutMs = check.timeout * 1000;
    const startedAt = Math.floor(Date.now() / 1000);

    const context: ProbeContext = {
      nodeName: node.name,
      host: node.host,
      domain: node.domain,
      executor: createExecutor(node, timeoutMs),
      startedAt,
      timeoutMs,
    };

    const outcome = await probe.run(context);

    const points: MetricPoint[] = [];

    if (outcome.ok) {
      points.push(...probe.toMetrics(outcome.data, context));
      points.push({
        ts: startedAt,
        node: node.name,
        metric: `${probe.name}.up`,
        ok: true,
        meta: { durationMs: outcome.durationMs },
      });
    } else {
      points.push({
        ts: startedAt,
        node: node.name,
        metric: `${probe.name}.up`,
        ok: false,
        meta: {
          errorKind: outcome.error.kind,
          detail: describeError(outcome.error),
          durationMs: outcome.durationMs,
        },
      });
    }

    await this.options.storage.write(points);
  }
}

function buildConcurrencyMap(config: Config): ReadonlyMap<string, number> {
  const map = new Map<string, number>();

  for (const [probeName, settings] of Object.entries(config.probes)) {
    map.set(probeName, settings.concurrency);
  }

  return map;
}

function describeError(error: ProbeError): string {
  switch (error.kind) {
    case "unreachable":
      return error.detail;
    case "not_configured":
      return `missing: ${error.what}`;
    case "bad_response":
      return `status: ${error.status ?? "unknown"}`;
    case "internal":
      return error.cause instanceof Error
        ? error.cause.message
        : String(error.cause);
    default:
      return error.kind;
  }
}
