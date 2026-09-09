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

/** Shared by `POST /api/check` and `ephor check` without a daemon. */
export interface CheckDeps {
  storage: Storage;
  nodes: readonly ResolvedNode[];
  probeNames: readonly string[];
  /** Unix seconds. */
  now: () => number;
  forceRun: (node?: string, probe?: string) => CheckRun;
}

/** Without a cap the check waits for every forced pair, however long. */
interface CheckCap {
  /** The run's own budget applies when it is lower. */
  ceilingMs: number;
  /** Rejects when `signal` aborts, ending the wait as if the cap ran out. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** The API's 404 and 400; the CLI exits 2 on both. */
export type CheckOutcome =
  | { kind: "unknown-node"; node: string }
  | { kind: "invalid"; reason: string }
  | { kind: "ran"; response: CheckResponse };

// A run that forces nothing is refused: `complete: true` with no data would
// read as success.
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

  // Before forcing: a probe stamps its points with a second at or after this.
  const startedAt = deps.now();
  const run = deps.forceRun(request.node, request.probe);

  if (run.tasks.length === 0) {
    return {
      kind: "invalid",
      reason: explainNothingToRun(deps.nodes, request),
    };
  }

  await waitFor(run, cap);

  // From the scheduler's books, not from timestamps: a previous run in the
  // same second would pass a timestamp test.
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

interface CheckWithoutDaemonOptions {
  config: Config;
  registry: ProbeRegistry;
  logger: Logger;
  request: CheckRequest;
}

/** The same collector, never started, over a database in memory; no cap. */
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

// The timer is cancelled once the run wins, so a three-second check leaves
// no four-minute timer behind.
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

// The node and the probe exist, so the probe is switched off where it was
// asked for; the message says by whom.
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
