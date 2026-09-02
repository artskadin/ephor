import {
  type Config,
  type Logger,
  type MetricPoint,
  type ProbeContext,
  type ProbeError,
  type ResolvedNode,
  resolveConcurrency,
  resolveConfig,
  type Storage,
} from "@ephor/core";
import { createExecutor } from "./execution/create-executor.js";
import { Pruner } from "./maintenance/pruner.js";
import type { ProbeRegistry } from "./probes/registry.js";
import { runWithRetry } from "./probes/with-retry.js";
import { systemClock } from "./scheduling/clock.js";
import { Scheduler, type Task } from "./scheduling/scheduler.js";
import { TaskExecutor } from "./scheduling/task-executor.js";

export interface CollectorOptions {
  config: Config;
  registry: ProbeRegistry;
  storage: Storage;
  logger: Logger;
}

export class Collector {
  private readonly scheduler: Scheduler;
  private readonly taskExecutor: TaskExecutor;
  private readonly resolvedNodes: ResolvedNode[];
  private readonly pruner: Pruner;

  constructor(private readonly options: CollectorOptions) {
    this.resolvedNodes = resolveConfig(
      options.config,
      options.registry.descriptors(),
    );

    this.scheduler = new Scheduler({
      clock: systemClock,
      onTasksDue: (tasks) => this.taskExecutor.submit(tasks),
    });

    this.taskExecutor = new TaskExecutor({
      concurrencyByProbe: resolveConcurrency(
        options.config,
        options.registry.descriptors(),
      ),
      handler: (task) => this.runProbe(task),
      onTaskFinished: (task) => this.scheduler.complete(task),
      logger: options.logger,
    });

    this.scheduler.setNodes(this.resolvedNodes);

    this.pruner = new Pruner({
      storage: options.storage,
      clock: systemClock,
      retentionSeconds: options.config.storage.retention,
      runAt: options.config.storage.pruneAt,
      onPruned: (removed) =>
        options.logger.info("pruned old metrics", { removed }),
    });
  }

  async start(): Promise<void> {
    await this.options.storage.migrate();

    this.scheduler.start();
    this.pruner.start();
  }

  stop(): void {
    this.scheduler.stop();
    this.pruner.stop();
  }

  runNow(nodeName?: string, probeName?: string): void {
    this.scheduler.runNow(nodeName, probeName);
  }

  /** Resolves once the queue has drained; false if it did not in time. */
  waitUntilIdle(timeoutMs: number): Promise<boolean> {
    return this.scheduler.waitUntilIdle(timeoutMs);
  }

  get runningTasks(): number {
    return this.scheduler.runningTasks;
  }

  /** The nodes actually being watched — disabled ones are already dropped. */
  get nodes(): readonly ResolvedNode[] {
    return this.resolvedNodes;
  }

  private async runProbe(task: Task): Promise<void> {
    const probe = this.options.registry.get(task.probe);
    const settings = task.node.probes.get(task.probe);
    const node = task.node.node;

    if (!probe || !settings) {
      this.options.logger.error("task names a probe that is not resolved", {
        node: node.name,
        probe: task.probe,
      });

      return;
    }

    const timeoutMs = settings.timeout * 1000;
    const startedAt = Math.floor(Date.now() / 1000);

    const context: ProbeContext = {
      nodeName: node.name,
      host: node.host,
      domain: node.domain,
      ports: node.ports,
      executor: createExecutor(node, timeoutMs),
      startedAt,
      timeoutMs,
      settings: settings.settings,
    };

    const outcome = await runWithRetry(probe, context, settings.retries);

    const logger = this.options.logger.child({
      node: node.name,
      probe: probe.descriptor.name,
    });

    const points: MetricPoint[] = [];

    if (outcome.ok) {
      points.push(...probe.toMetrics(outcome.data, context));
      points.push({
        ts: startedAt,
        node: node.name,
        metric: `${probe.descriptor.name}.up`,
        ok: true,
        meta: { durationMs: outcome.durationMs },
      });

      logger.debug("probe finished", {
        durationMs: outcome.durationMs,
        points: points.length,
      });
    } else {
      points.push({
        ts: startedAt,
        node: node.name,
        metric: `${probe.descriptor.name}.up`,
        ok: false,
        meta: {
          errorKind: outcome.error.kind,
          detail: describeError(outcome.error),
          durationMs: outcome.durationMs,
        },
      });

      // A failing probe is worth a line every cycle: the metric records it
      // for the UI, but only the log says it while the UI does not exist.
      logger.warn("probe failed", {
        errorKind: outcome.error.kind,
        detail: describeError(outcome.error),
        durationMs: outcome.durationMs,
      });
    }

    await this.options.storage.write(points);
  }
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
