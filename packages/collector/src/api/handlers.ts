import {
  buildNodeState,
  CHECK_MAX_WAIT_SECONDS,
  type CheckRequest,
  type CheckResponse,
  type HealthResponse,
  METRICS_QUERY_DEFAULT_LIMIT,
  METRICS_QUERY_DEFAULT_WINDOW_SECONDS,
  type MetricsQuery,
  type MetricsResponse,
  type NodeResponse,
  type ResolvedNode,
  type StateResponse,
  type Storage,
} from "@ephor/core";
import type { CheckRun } from "../collector.js";

/**
 * Everything the answers are built from. Passed in rather than reached for,
 * so a handler can be tested with a fake storage and a frozen clock and no
 * server at all.
 */
export interface ApiDeps {
  storage: Storage;
  /** The nodes actually being watched; disabled ones are already gone. */
  nodes: readonly ResolvedNode[];
  probeNames: readonly string[];
  /** Unix seconds. */
  now: () => number;
  /**
   * Resolves after that many milliseconds, or rejects when `signal` aborts —
   * which the collector does on shutdown, so a waiting check does not hold
   * the process for minutes. Injected alongside `now`: a test that freezes
   * one must hold the other, or the wait for a forced run either takes real
   * minutes or ends before it began.
   */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Unix seconds, when the collector started. */
  startedAt: number;
  runningTasks: () => number;
  /** Forces the matching pairs to run now; see `Collector.runNow`. */
  forceRun: (node?: string, probe?: string) => CheckRun;
}

/**
 * A request that parsed but cannot be answered as asked. Thrown rather than
 * returned so the handlers stay plain functions; the server turns it into a
 * 400 and everything else into a 500.
 */
export class InvalidQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidQueryError";
  }
}

/**
 * Handlers know nothing about HTTP — no request, no response, no framework.
 * That is what keeps Fastify to a single file: replacing it rewrites the
 * routing, not the answers.
 */

export async function getState(deps: ApiDeps): Promise<StateResponse> {
  const now = deps.now();

  return {
    now,
    nodes: buildNodeState({
      nodes: deps.nodes,
      points: await deps.storage.latest(),
      now,
    }),
  };
}

/** `undefined` when no configured node has that name — the route's 404. */
export async function getNode(
  deps: ApiDeps,
  name: string,
): Promise<NodeResponse | undefined> {
  const node = deps.nodes.find((candidate) => candidate.node.name === name);
  if (!node) return undefined;

  const now = deps.now();
  const [state] = buildNodeState({
    nodes: [node],
    points: await deps.storage.latest(name),
    now,
  });

  // One node in, one state out — `buildNodeState` maps over its input. The
  // type cannot see that, and an impossible outcome should be loud, not a
  // 404 claiming the node is not configured.
  if (!state) {
    throw new Error(`buildNodeState returned nothing for node "${name}"`);
  }

  return { now, node: state };
}

/**
 * History, bounded on every axis. The window defaults to the last hour and
 * the count to a thousand, and the answer says when it was cut short.
 */
export async function getMetrics(
  deps: ApiDeps,
  query: MetricsQuery,
): Promise<MetricsResponse> {
  const to = query.to ?? deps.now();
  // Clamped: the schema promises a non-negative `from`, and a small `to`
  // must not make the response hand back a number its own input refuses.
  const from =
    query.from ?? Math.max(0, to - METRICS_QUERY_DEFAULT_WINDOW_SECONDS);
  const limit = query.limit ?? METRICS_QUERY_DEFAULT_LIMIT;

  // The schema checks this only when both bounds were supplied; a `from` in
  // the future against a defaulted `to` slips past it and would otherwise
  // come back as a silent, empty 200.
  if (from > to) {
    throw new InvalidQueryError("from must not be later than to");
  }

  // One more than asked for: if it arrives, the window held more than fits,
  // and that is known for certain rather than guessed from a full page.
  const fetched = await deps.storage.query({
    node: query.node,
    metric: query.metric,
    from,
    to,
    limit: limit + 1,
  });

  if (fetched.length <= limit) {
    return { points: fetched, truncated: false, from, to, limit };
  }

  return {
    points: endOnCompleteInstant(fetched, limit),
    truncated: true,
    from,
    to,
    limit,
  };
}

/**
 * A page that stops in the middle of one timestamp is a page that loses
 * rows: one probe run writes all of its metrics with one `ts`, and a client
 * paging by time window continues from `oldest.ts - 1` — below the instant
 * it was cut in, so the rest of that instant is never returned. The cut is
 * therefore moved back to the last complete instant.
 *
 * `fetched` holds `limit + 1` rows, so the row at `limit` is the first one
 * that did not fit, and every row in the page sharing its timestamp belongs
 * to an instant the page does not hold in full.
 */
function endOnCompleteInstant<T extends { ts: number }>(
  fetched: readonly T[],
  limit: number,
): T[] {
  const overflowTs = fetched[limit]?.ts;
  const page = fetched.slice(0, limit);
  const complete = page.filter((point) => point.ts !== overflowTs);

  // One instant wider than the whole page: nothing to move the cut back to.
  // Returned as is, still marked truncated — a limit smaller than the number
  // of metrics a probe writes at once cannot page cleanly by construction.
  return complete.length > 0 ? complete : page;
}

/**
 * Forces a run and waits for it, then answers with the state it produced.
 *
 * Blocks rather than returning a ticket: a script gets one call and one
 * answer. The wait is bounded by the run's own budget — see `waitBudgetMs` —
 * under a fixed ceiling, and the response says whether the run finished
 * inside it; the probes keep
 * going either way, and a client that was told `complete: false` polls
 * `/api/state` rather than posting again.
 *
 * `undefined` when the request names a node that is not configured — the
 * route's 404. Everything else it cannot do is a 400 that says why: a run
 * that forces nothing would otherwise come back `complete: true` with no
 * data, which reads as success.
 */
export async function postCheck(
  deps: ApiDeps,
  request: CheckRequest,
): Promise<CheckResponse | undefined> {
  if (
    request.node !== undefined &&
    !deps.nodes.some((node) => node.node.name === request.node)
  ) {
    return undefined;
  }

  if (request.probe !== undefined && !deps.probeNames.includes(request.probe)) {
    throw new InvalidQueryError(
      `unknown probe "${request.probe}". Available: ${deps.probeNames.join(", ")}`,
    );
  }

  // Taken before forcing: a probe stamps its points with the second it
  // started in, and that second is at or after this one.
  const startedAt = deps.now();
  const run = deps.forceRun(request.node, request.probe);

  if (run.tasks.length === 0) {
    throw new InvalidQueryError(explainNothingToRun(deps.nodes, request));
  }

  // The run's own budget, never more than the contract promises. The timer
  // is cancelled once the run wins, so a three-second check does not leave a
  // four-minute timer behind; a sleep cut short from outside — shutdown —
  // ends the wait as if the cap had run out.
  const cap = new AbortController();

  try {
    await Promise.race([
      run.finished,
      deps
        .sleep(
          Math.min(CHECK_MAX_WAIT_SECONDS * 1000, run.budgetMs),
          cap.signal,
        )
        .catch(() => undefined),
    ]);
  } finally {
    cap.abort();
  }

  // From the scheduler's own books rather than from timestamps in storage:
  // a previous run stamped in the same second would pass a timestamp test,
  // and a clock stepped back would fail one until the next cycle.
  const unfinished = run.unfinished();
  const now = deps.now();

  return {
    now,
    nodes: buildNodeState({
      nodes: deps.nodes,
      points: await deps.storage.latest(),
      now,
    }),
    startedAt,
    complete: unfinished.length === 0,
    pending: [...new Set(unfinished.map((task) => task.node.node.name))],
  };
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

export function getHealth(deps: ApiDeps): HealthResponse {
  return {
    ok: true,
    // Clamped because a clock stepped backwards — ntp correcting a fresh VPS
    // is the usual cause — would otherwise report a negative uptime.
    uptimeSeconds: Math.max(0, deps.now() - deps.startedAt),
    runningTasks: deps.runningTasks(),
    nodes: deps.nodes.length,
    probes: [...deps.probeNames],
  };
}
