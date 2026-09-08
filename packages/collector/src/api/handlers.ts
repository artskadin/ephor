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
  type QueueState,
  type SshQueues,
  type StateResponse,
} from "@ephorate/core";
import { type CheckDeps, checkOnce } from "../check.js";

/**
 * Everything the answers are built from: what a check needs, and what only
 * a server has. Passed in rather than reached for, so a handler can be
 * tested with a fake storage and a frozen clock and no server at all.
 */
export interface ApiDeps extends CheckDeps {
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
  /** Every probe's queue; see `Collector.queues`. */
  queues: () => Record<string, QueueState>;
  /** What is in line at the ssh limits; see `Collector.sshQueues`. */
  sshQueues: () => SshQueues;
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
 * inside it; the probes keep going either way, and a client that was told
 * `complete: false` polls `/api/state` rather than posting again.
 *
 * The check is `checkOnce`. The route's own part is the cap (the ceiling,
 * and a sleep the collector cuts short on shutdown) and the statuses:
 * `undefined` for a node that is not configured, the route's 404, and a
 * 400 that says why for everything else it cannot do.
 */
export async function postCheck(
  deps: ApiDeps,
  request: CheckRequest,
): Promise<CheckResponse | undefined> {
  const outcome = await checkOnce(deps, request, {
    ceilingMs: CHECK_MAX_WAIT_SECONDS * 1000,
    sleep: deps.sleep,
  });

  if (outcome.kind === "unknown-node") return undefined;
  if (outcome.kind === "invalid") throw new InvalidQueryError(outcome.reason);

  return outcome.response;
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
    queues: deps.queues(),
    ssh: deps.sshQueues(),
  };
}
