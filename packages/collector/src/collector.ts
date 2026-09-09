import {
  type Config,
  type Logger,
  type MetricPoint,
  type ProbeContext,
  type ProbeError,
  type QueueState,
  type ResolvedNode,
  resolveConcurrency,
  resolveConfig,
  type SshQueues,
  type Storage,
} from "@ephorate/core";
import { createExecutor } from "./execution/create-executor.js";
import { SshGates } from "./execution/ssh-gates.js";
import { inspectSshOptions } from "./execution/ssh-route.js";
import { Pruner } from "./maintenance/pruner.js";
import type { ProbeRegistry } from "./probes/registry.js";
import { runWithRetry } from "./probes/with-retry.js";
import { systemClock } from "./scheduling/clock.js";
import {
  type ForcedRun,
  Scheduler,
  type Task,
} from "./scheduling/scheduler.js";
import { TaskExecutor } from "./scheduling/task-executor.js";
import { waitBudgetMs } from "./scheduling/wait-budget.js";

interface CollectorOptions {
  config: Config;
  registry: ProbeRegistry;
  storage: Storage;
  logger: Logger;
}

export interface CheckRun extends ForcedRun {
  /** Milliseconds the run can take under the current queues. */
  budgetMs: number;
}

export class Collector {
  private readonly scheduler: Scheduler;
  private readonly taskExecutor: TaskExecutor;
  private readonly resolvedNodes: ResolvedNode[];
  private readonly pruner: Pruner;
  /** Shared by every ssh probe: the limits are ssh's. */
  private readonly sshGates: SshGates;

  constructor(private readonly options: CollectorOptions) {
    this.resolvedNodes = resolveConfig(
      options.config,
      options.registry.descriptors(),
    );

    this.sshGates = new SshGates({
      inspect: inspectSshOptions,
      logger: options.logger.child({ component: "ssh" }),
    });

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

  /** The budget is computed here, where the queues are, for both callers. */
  runNow(nodeName?: string, probeName?: string): CheckRun {
    const run = this.scheduler.runNow(nodeName, probeName);

    return {
      ...run,
      budgetMs: waitBudgetMs(run, (probe) => this.queueState(probe)),
    };
  }

  /** Throws for an unregistered probe: a missing limit is a bug, not zero. */
  queueState(probeName: string): QueueState {
    const queue = this.taskExecutor.queueState(probeName);

    if (!queue) {
      throw new Error(`no concurrency limit for probe "${probeName}"`);
    }

    return queue;
  }

  queues(): Record<string, QueueState> {
    return Object.fromEntries(this.taskExecutor.queues());
  }

  sshQueues(): SshQueues {
    return this.sshGates.queues();
  }

  get runningTasks(): number {
    return this.scheduler.runningTasks;
  }

  /** Disabled nodes already dropped. */
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
      executor: createExecutor(node, timeoutMs, this.sshGates),
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
          detail: probeErrorDetail(outcome.error),
          durationMs: outcome.durationMs,
        },
      });

      logger.warn("probe failed", {
        errorKind: outcome.error.kind,
        detail: probeErrorDetail(outcome.error),
        durationMs: outcome.durationMs,
      });
    }

    await this.options.storage.write(points);
  }
}

function probeErrorDetail(error: ProbeError): string {
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
