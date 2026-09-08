import {
  buildNodeState,
  type CheckRequest,
  type CheckResponse,
  type Config,
  type Logger,
  type ResolvedNode,
  type Storage,
} from "@ephorate/core";
import { type CheckRun, Collector } from "./collector.js";
import type { ProbeRegistry } from "./probes/registry.js";
import { SqliteStorage } from "./storage/sqlite-storage.js";

/**
 * What a check is built from. One set for both callers, so `POST /api/check`
 * and `ephor check` without a daemon cannot drift in what they force or how
 * they describe it; the API adds what only a server has.
 */
export interface CheckDeps {
  storage: Storage;
  /** The nodes actually being watched; disabled ones are already gone. */
  nodes: readonly ResolvedNode[];
  probeNames: readonly string[];
  /** Unix seconds. */
  now: () => number;
  /** Forces the matching pairs to run now; see `Collector.runNow`. */
  forceRun: (node?: string, probe?: string) => CheckRun;
}

/**
 * How long a caller is prepared to wait. Without one, the check waits for
 * every forced pair, however long: `ephor check` without a daemon has
 * nobody to hand the rest of the run to. The API has — the probes keep
 * running after it answers — and caps the wait at the run's own budget
 * under its ceiling.
 */
export interface CheckCap {
  /** The ceiling; the run's own budget applies when it is lower. */
  ceilingMs: number;
  /**
   * Resolves after that many milliseconds, or rejects when `signal` aborts,
   * which ends the wait as if the cap had run out. Injected alongside
   * `now`: a test that freezes one must hold the other.
   */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * The three things a check can come to. Which of the first two it is
 * matters to the API — a node nobody configured is a 404, everything else
 * it cannot do a 400 — and not to the command line, where both are a
 * message and exit code 2.
 */
export type CheckOutcome =
  | { kind: "unknown-node"; node: string }
  | { kind: "invalid"; reason: string }
  | { kind: "ran"; response: CheckResponse };

/**
 * Forces a run, waits for it, and describes what it produced.
 *
 * A run that forces nothing is refused with the reason rather than answered:
 * it would otherwise come back `complete: true` with no data, which reads
 * as success.
 */
export async function checkOnce(
  deps: CheckDeps,
  request: CheckRequest,
  cap?: CheckCap,
): Promise<CheckOutcome> {
  if (
    request.node !== undefined &&
    !deps.nodes.some((node) => node.node.name === request.node)
  ) {
    return { kind: "unknown-node", node: request.node };
  }

  if (request.probe !== undefined && !deps.probeNames.includes(request.probe)) {
    return {
      kind: "invalid",
      reason: `unknown probe "${request.probe}". Available: ${deps.probeNames.join(", ")}`,
    };
  }

  // Taken before forcing: a probe stamps its points with the second it
  // started in, and that second is at or after this one.
  const startedAt = deps.now();
  const run = deps.forceRun(request.node, request.probe);

  if (run.tasks.length === 0) {
    return {
      kind: "invalid",
      reason: explainNothingToRun(deps.nodes, request),
    };
  }

  await waitFor(run, cap);

  // From the scheduler's own books rather than from timestamps in storage:
  // a previous run stamped in the same second would pass a timestamp test,
  // and a clock stepped back would fail one until the next cycle.
  const unfinished = run.unfinished();
  const now = deps.now();

  return {
    kind: "ran",
    response: {
      now,
      nodes: buildNodeState({
        nodes: deps.nodes,
        points: await deps.storage.latest(),
        now,
      }),
      startedAt,
      complete: unfinished.length === 0,
      pending: [...new Set(unfinished.map((task) => task.node.node.name))],
    },
  };
}

export interface CheckWithoutDaemonOptions {
  config: Config;
  registry: ProbeRegistry;
  logger: Logger;
  request: CheckRequest;
}

/**
 * Deployment 5: the same collector, never started — no server, no timers.
 * The pairs run once against a database in memory, since there is no
 * history to keep and nothing to be stale against, and the answer is what
 * the API would have given, waited for in full.
 */
export async function checkWithoutDaemon(
  options: CheckWithoutDaemonOptions,
): Promise<CheckOutcome> {
  const storage = new SqliteStorage(":memory:");

  try {
    const collector = new Collector({
      config: options.config,
      registry: options.registry,
      storage,
      logger: options.logger,
    });

    await storage.migrate();

    return await checkOnce(
      {
        storage,
        nodes: collector.nodes,
        probeNames: options.registry.names(),
        now: () => Math.floor(Date.now() / 1000),
        forceRun: (node, probe) => collector.runNow(node, probe),
      },
      options.request,
    );
  } finally {
    await storage.close();
  }
}

/**
 * Under a cap, the run's own budget or the ceiling, whichever is lower. The
 * timer is cancelled once the run wins, so a three-second check does not
 * leave a four-minute timer behind; a sleep cut short from outside —
 * shutdown — ends the wait as if the cap had run out.
 */
async function waitFor(
  run: CheckRun,
  cap: CheckCap | undefined,
): Promise<void> {
  if (!cap) {
    await run.finished;

    return;
  }

  const timer = new AbortController();

  try {
    await Promise.race([
      run.finished,
      cap
        .sleep(Math.min(cap.ceilingMs, run.budgetMs), timer.signal)
        .catch(() => undefined),
    ]);
  } finally {
    timer.abort();
  }
}

/**
 * Why a request that named real things still had nothing to run. The probe
 * exists and the node exists; what is left is the probe being switched off
 * where it was asked for, and the message says by whom — the config, or
 * the node lacking the access the probe needs.
 */
function explainNothingToRun(
  nodes: readonly ResolvedNode[],
  request: CheckRequest,
): string {
  const { node: nodeName, probe: probeName } = request;
  const what = `${probeName ?? "every probe"} is disabled on ${nodeName ?? "every node"}`;

  if (nodeName === undefined || probeName === undefined) {
    return nodeName === undefined && probeName === undefined
      ? `nothing to check: ${what}`
      : what;
  }

  const probe = nodes
    .find((candidate) => candidate.node.name === nodeName)
    ?.probes.get(probeName);
  const reason =
    probe?.disabledReason === "no-executor"
      ? `it needs ssh access and ${nodeName} has none`
      : "switched off in the config";

  return `${what}: ${reason}`;
}
