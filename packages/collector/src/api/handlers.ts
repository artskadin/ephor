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

// Handlers know nothing about HTTP; Fastify lives in `server.ts` alone.

export interface ApiDeps extends CheckDeps {
  /** Rejects when `signal` aborts, which the collector does on shutdown. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Unix seconds. */
  startedAt: number;
  runningTasks: () => number;
  queues: () => Record<string, QueueState>;
  sshQueues: () => SshQueues;
}

/** Parsed, but cannot be answered as asked: the server's 400. */
export class InvalidQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidQueryError";
  }
}

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

/** `undefined` for a node nobody configured: the route's 404. */
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

  if (!state) {
    throw new Error(`buildNodeState returned nothing for node "${name}"`);
  }

  return { now, node: state };
}

export async function getMetrics(
  deps: ApiDeps,
  query: MetricsQuery,
): Promise<MetricsResponse> {
  const to = query.to ?? deps.now();
  // Clamped: the schema promises a non-negative `from`.
  const from =
    query.from ?? Math.max(0, to - METRICS_QUERY_DEFAULT_WINDOW_SECONDS);
  const limit = query.limit ?? METRICS_QUERY_DEFAULT_LIMIT;

  // The schema checks this only when both bounds were supplied.
  if (from > to) {
    throw new InvalidQueryError("from must not be later than to");
  }

  // One more than asked: if it arrives, the window held more than fits.
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

// A client paging by `oldest.ts - 1` would skip the rest of an instant the
// page was cut in, so the cut moves back to the last complete one.
function endOnCompleteInstant<T extends { ts: number }>(
  fetched: readonly T[],
  limit: number,
): T[] {
  const overflowTs = fetched[limit]?.ts;
  const page = fetched.slice(0, limit);
  const complete = page.filter((point) => point.ts !== overflowTs);

  // One instant wider than the page: nothing to move the cut back to.
  return complete.length > 0 ? complete : page;
}

/** Blocks under the run's budget and a ceiling; `undefined` is a 404. */
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
    // A clock stepped backwards would report a negative uptime.
    uptimeSeconds: Math.max(0, deps.now() - deps.startedAt),
    runningTasks: deps.runningTasks(),
    nodes: deps.nodes.length,
    probes: [...deps.probeNames],
    queues: deps.queues(),
    ssh: deps.sshQueues(),
  };
}
