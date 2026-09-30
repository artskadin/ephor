import {
  type Acknowledgement,
  buildNodeState,
  type Config,
  type Logger,
  type MetricPoint,
  type MetricStatus,
  type ProbeContext,
  type ProbeError,
  type QueueState,
  type ResolvedNode,
  resolveConcurrency,
  resolveConfig,
  type SshQueues,
  type Storage,
} from "@ephorate/core";
import { createExecutor } from "./execution/create-executor";
import { SshGates } from "./execution/ssh-gates";
import { inspectSshOptions } from "./execution/ssh-route";
import { Pruner } from "./maintenance/pruner";
import type { ProbeRegistry } from "./probes/registry";
import { runWithRetry } from "./probes/with-retry";
import { systemClock } from "./scheduling/clock";
import { type ForcedRun, Scheduler, type Task } from "./scheduling/scheduler";
import { TaskExecutor } from "./scheduling/task-executor";
import { waitBudgetMs } from "./scheduling/wait-budget";
import { WakeWatch } from "./scheduling/wake-watch";

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
  private readonly wakeWatch: WakeWatch;

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

    this.wakeWatch = new WakeWatch({
      clock: systemClock,
      onWake: (gapMs) =>
        options.logger.info("collector resumed after a gap", {
          gapSeconds: Math.round(gapMs / 1000),
        }),
    });
  }

  async start(): Promise<void> {
    await this.options.storage.migrate();

    this.wakeWatch.start();
    this.scheduler.start();
    this.pruner.start();
  }

  stop(): void {
    this.scheduler.stop();
    this.pruner.stop();
    this.wakeWatch.stop();
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

    // The measurement is stored; a failure here must not fail the task.
    await this.settleAcknowledgement(task.node).catch((cause: unknown) =>
      logger.error("acknowledgement not settled", { cause }),
    );
  }

  private async settleAcknowledgement(node: ResolvedNode): Promise<void> {
    const name = node.node.name;
    const now = Math.floor(Date.now() / 1000);
    const acknowledgement = (
      await this.options.storage.acknowledgements(now)
    ).find((each) => each.node === name);
    if (!acknowledgement) return;

    const points = await this.options.storage.latest(name);

    // Until every enabled probe has run since the start or a wake, a stale
    // value may be the collector's own absence, not news of the node.
    const awakeSince = Math.floor(this.wakeWatch.awakeSince / 1000);
    for (const [probe, settings] of node.probes) {
      if (!settings.enabled) continue;
      const up = points.find((point) => point.metric === `${probe}.up`);
      if (up === undefined || up.ts < awakeSince) return;
    }

    const [state] = buildNodeState({ nodes: [node], points, now });
    if (!state) {
      throw new Error(`buildNodeState returned nothing for node "${name}"`);
    }

    if (!isAcknowledgementOver(acknowledgement, state.status)) return;

    await this.options.storage.unacknowledge(name);
    this.options.logger.info("acknowledgement cleared", {
      node: name,
      acknowledged: acknowledgement.status,
      status: state.status,
      untilOk: acknowledgement.untilOk,
    });
  }
}

function isAcknowledgementOver(
  acknowledgement: Acknowledgement,
  status: MetricStatus,
): boolean {
  return acknowledgement.untilOk
    ? status === "ok"
    : status !== acknowledgement.status;
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
