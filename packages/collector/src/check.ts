import {
  buildNodeState,
  type CheckRequest,
  type CheckResponse,
  type Config,
  describeProbeSelection,
  type Logger,
  type ProbeNotRun,
  probeNamesInRequest,
  type ResolvedNode,
  requestedProbeNames,
  type Storage,
  selectProbeNames,
} from "@ephorate/core";
import { type CheckRun, Collector } from "./collector";
import type { ProbeRegistry } from "./probes/registry";
import { SqliteStorage } from "./storage/sqlite-storage";

/** Shared by `POST /api/check` and `ephor check` without a daemon. */
export interface CheckDeps {
  storage: Storage;
  nodes: readonly ResolvedNode[];
  probeNames: readonly string[];
  /** Unix seconds. */
  now: () => number;
  forceRun: (nodeName?: string, probeNames?: readonly string[]) => CheckRun;
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
    !deps.nodes.some((node) => node.config.name === request.node)
  ) {
    return { kind: "unknown-node", node: request.node };
  }

  const unknownProbe = probeNamesInRequest(request).find(
    (name) => !deps.probeNames.includes(name),
  );
  if (unknownProbe !== undefined) {
    return {
      kind: "invalid",
      reason: `unknown probe "${unknownProbe}". Available: ${deps.probeNames.join(", ")}`,
    };
  }

  // Before forcing: a probe stamps its points with a second at or after this.
  const startedAt = deps.now();
  const probeNamesToRun = selectProbeNames(request, deps.probeNames);
  const run = deps.forceRun(request.node, probeNamesToRun);

  if (run.tasks.length === 0) {
    return {
      kind: "invalid",
      reason:
        probeNamesToRun.length === 0
          ? "nothing to check: every probe is skipped"
          : explainNothingToRun(deps.nodes, request, probeNamesToRun),
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
        acknowledgements: await deps.storage.acknowledgements(now),
      }),
      startedAt,
      complete: unfinished.length === 0,
      pending: [...new Set(unfinished.map((task) => task.node.config.name))],
      notRun: listProbesNotRun(deps.nodes, request, probeNamesToRun),
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
        forceRun: (nodeName, probeNames) =>
          collector.runNow(nodeName, probeNames),
      },
      options.request,
    );
  } finally {
    await storage.close();
  }
}

// A probe off on a node is news only when it was named, or is on for
// another node: one off everywhere (speed until switched on) stays quiet.
function listProbesNotRun(
  nodes: readonly ResolvedNode[],
  request: CheckRequest,
  probeNamesToRun: readonly string[],
): ProbeNotRun[] {
  const namedProbeNames = requestedProbeNames(request);
  const checkedNodes =
    request.node === undefined
      ? nodes
      : nodes.filter((node) => node.config.name === request.node);
  const isWorthReporting = (probeName: string, node: ResolvedNode): boolean =>
    namedProbeNames.includes(probeName) ||
    nodes.some(
      (other) =>
        other !== node && other.probes.get(probeName)?.enabled === true,
    );

  // By probe, then node: a reader groups by probe.
  return probeNamesToRun.flatMap((probeName) =>
    checkedNodes.flatMap((node): ProbeNotRun[] => {
      const resolvedProbe = node.probes.get(probeName);
      if (resolvedProbe === undefined || resolvedProbe.enabled) return [];
      if (!isWorthReporting(probeName, node)) return [];

      return [
        {
          node: node.config.name,
          probe: probeName,
          disabledReason: resolvedProbe.disabledReason,
        },
      ];
    }),
  );
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

// The node and the probes exist, so they are switched off where they were
// asked for; the message says by whom.
function explainNothingToRun(
  nodes: readonly ResolvedNode[],
  request: CheckRequest,
  probeNamesToRun: readonly string[],
): string {
  const nodeName = request.node;
  const onlyProbeName =
    probeNamesToRun.length === 1 ? probeNamesToRun[0] : undefined;
  const verb = probeNamesToRun.length > 1 && request.probes ? "are" : "is";
  const disabledText = `${describeProbeSelection(request)} ${verb} disabled on ${nodeName ?? "every node"}`;

  // A reason only for one probe on one node: several could differ.
  if (nodeName === undefined || onlyProbeName === undefined) {
    return nodeName === undefined && request.probe === undefined
      ? `nothing to check: ${disabledText}`
      : disabledText;
  }

  const resolvedProbe = nodes
    .find((candidate) => candidate.config.name === nodeName)
    ?.probes.get(onlyProbeName);
  const reasonText =
    resolvedProbe?.enabled === false &&
    resolvedProbe.disabledReason === "no-executor"
      ? `it needs ssh access and ${nodeName} has none`
      : "switched off in the config";

  return `${disabledText}: ${reasonText}`;
}
