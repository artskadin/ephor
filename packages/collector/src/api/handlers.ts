import {
  type Acknowledgement,
  type AcknowledgeRequest,
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
import { type CheckDeps, checkOnce } from "../check";

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
      acknowledgements: await deps.storage.acknowledgements(now),
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
    acknowledgements: await deps.storage.acknowledgements(now),
  });

  if (!state) {
    throw new Error(`buildNodeState returned nothing for node "${name}"`);
  }

  return { now, node: state };
}

type Acknowledged =
  | { kind: "unknown-node" }
  | { kind: "nothing-wrong" }
  | { kind: "stored"; acknowledgement: Acknowledgement };

// What is acknowledged is the status the operator sees now: the default
// kind ends the moment it changes. An ok node has nothing to own.
export async function putAcknowledgement(
  deps: ApiDeps,
  name: string,
  request: AcknowledgeRequest,
): Promise<Acknowledged> {
  const node = deps.nodes.find((candidate) => candidate.node.name === name);
  if (!node) return { kind: "unknown-node" };

  const since = deps.now();
  const [state] = buildNodeState({
    nodes: [node],
    points: await deps.storage.latest(name),
    now: since,
  });
  if (!state) {
    throw new Error(`buildNodeState returned nothing for node "${name}"`);
  }

  const { status } = state;
  if (status === "ok") return { kind: "nothing-wrong" };

  const acknowledgement: Acknowledgement = {
    node: name,
    since,
    status,
    untilOk: request.untilOk ?? false,
  };
  if (request.note !== undefined) acknowledgement.note = request.note;
  if (request.duration !== undefined) {
    acknowledgement.until = since + request.duration;
  }

  await deps.storage.acknowledge(acknowledgement);

  return { kind: "stored", acknowledgement };
}

type Unacknowledged =
  | { kind: "unknown-node" }
  | { kind: "none" }
  | { kind: "removed"; acknowledgement: Acknowledgement };

// One expired but not yet swept is "none": it silenced nothing any more.
export async function deleteAcknowledgement(
  deps: ApiDeps,
  name: string,
): Promise<Unacknowledged> {
  if (!deps.nodes.some((candidate) => candidate.node.name === name)) {
    return { kind: "unknown-node" };
  }

  const inForce = (await deps.storage.acknowledgements(deps.now())).find(
    (each) => each.node === name,
  );
  await deps.storage.unacknowledge(name);

  return inForce === undefined
    ? { kind: "none" }
    : { kind: "removed", acknowledgement: inForce };
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

/** The version is the server's to add: the handlers do not know it. */
export function getHealth(deps: ApiDeps): Omit<HealthResponse, "version"> {
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
