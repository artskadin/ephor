import { checkWithoutDaemon, createRegistry } from "@ephorate/collector";
import {
  CHECK_MAX_WAIT_SECONDS,
  type CheckRequest,
  type CheckResponse,
  ConfigError,
  type Logger,
  loadConfig,
  type NodeState,
  type StateResponse,
} from "@ephorate/core";
import { ApiError } from "../api-client.js";
import { UsageError } from "../exit-code.js";
import { stateText } from "../render/state-text.js";

/** What `ApiClient` offers; an interface so a test can stand one in. */
export interface CollectorClient {
  apiUrl: string;
  check(request: CheckRequest): Promise<CheckResponse>;
  state(): Promise<StateResponse>;
}

interface CheckOptions {
  configPath: string;
  request: CheckRequest;
  /** Set when a token is configured: the daemon is asked first. */
  client: CollectorClient | undefined;
  json: boolean;
  colour: boolean;
  logger: Logger;
  /** Stdout is the data channel; everything for a person goes to stderr. */
  print: (line: string) => void;
  note: (line: string) => void;
}

const POLL_INTERVAL_MS = 2000;

/**
 * Through the daemon when there is one, else the probes once in this
 * process, over a database in memory. Returning is the whole answer.
 */
export async function runCheck(options: CheckOptions): Promise<void> {
  const { request } = options;

  const response = options.client
    ? await checkThroughDaemon(options.client, options)
    : await checkHere(options);

  options.print(
    await stateText(
      // JSON keeps the API's shape, every node; the table shows what was
      // asked for, the rest "has not reported yet".
      options.json ? response : onlyTheNodeAsked(response, request),
      options,
    ),
  );
}

// A refused connection on this machine is the one failure that means "no
// daemon": then once here, same keys, same route. Refused through a tunnel
// is a remote daemon down, and probing from here would swap both.
// `client` apart from `options`: narrowing does not cross a call.
async function checkThroughDaemon(
  client: CollectorClient,
  options: CheckOptions,
): Promise<CheckResponse> {
  let response: CheckResponse;

  try {
    response = await client.check(options.request);
  } catch (error) {
    if (
      !(error instanceof ApiError && error.failure === "refused") ||
      !isLoopback(client.apiUrl)
    ) {
      throw error;
    }

    options.note(
      `no \`ephor serve\` at ${client.apiUrl}: ran once here, nothing recorded`,
    );

    return checkHere(options);
  }

  return response.complete ? response : awaitPending(client, response, options);
}

function isLoopback(apiUrl: string): boolean {
  const { hostname } = new URL(apiUrl);

  return ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
}

/**
 * The daemon gave up waiting at its cap, not the run: `/api/state` is
 * polled, never a second POST (that would force again). A pair is done
 * once its `<probe>.up` is newer than in the daemon's answer: nothing
 * else runs that pair while the forced task is in flight.
 */
async function awaitPending(
  client: CollectorClient,
  response: CheckResponse,
  options: CheckOptions,
): Promise<CheckResponse> {
  const { request, note } = options;
  const deadline = Date.now() + CHECK_MAX_WAIT_SECONDS * 1000;
  const baseline = new Map(
    response.nodes.map((node) => [node.node, node] as const),
  );
  let pending = response.pending;
  let state: StateResponse = response;
  let lastNoted = "";

  while (pending.length > 0) {
    const line = `still running on ${pending.length}: ${pending.join(", ")}`;
    if (line !== lastNoted) note(line);
    lastNoted = line;

    if (Date.now() >= deadline) {
      note(
        `giving up after ${CHECK_MAX_WAIT_SECONDS} s: what follows is incomplete`,
      );
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    state = await client.state();

    // A pending node missing from the state stays pending: silently done
    // would be a lie.
    pending = pending.filter((name) => {
      const now = state.nodes.find((node) => node.node === name);
      const before = baseline.get(name);

      return !(now && before && hasReportedSince(now, before, request.probe));
    });
  }

  return {
    ...state,
    startedAt: response.startedAt,
    complete: pending.length === 0,
    pending,
  };
}

/** A probe not enabled on the node cannot report, so it does not count. */
function hasReportedSince(
  node: NodeState,
  before: NodeState,
  probe: string | undefined,
): boolean {
  const probes =
    probe === undefined
      ? node.probes
      : node.probes.filter((name) => name === probe);

  return probes.every((name) => {
    const metric = `${name}.up`;
    const previous = before.metrics.find((view) => view.metric === metric)?.ts;
    const current = node.metrics.find((view) => view.metric === metric)?.ts;

    return (
      current !== undefined && (previous === undefined || current > previous)
    );
  });
}

async function checkHere(options: CheckOptions): Promise<CheckResponse> {
  const { configPath, request } = options;
  const registry = createRegistry();

  const config = await loadConfig(configPath, registry.descriptors()).catch(
    (error: unknown) => {
      throw error instanceof ConfigError
        ? new UsageError(error.message)
        : error;
    },
  );

  // A fleet takes seconds; silence that long reads as a hang. Not for a
  // node or probe the check is about to refuse: that error says it all.
  const nodeNames = config.nodes.map((node) => node.name);
  if (
    (request.node === undefined || nodeNames.includes(request.node)) &&
    (request.probe === undefined || registry.names().includes(request.probe))
  ) {
    options.note(
      `checking ${request.node ?? "every node"}: ${request.probe ?? "every probe"}`,
    );
  }

  const outcome = await checkWithoutDaemon({
    config,
    registry,
    logger: options.logger,
    request,
  });

  switch (outcome.kind) {
    case "unknown-node":
      throw new UsageError(
        `unknown node "${outcome.node}". Nodes in ${configPath}: ${nodeNames.join(", ")}`,
      );
    case "invalid":
      throw new UsageError(outcome.reason);
    case "ran":
      return outcome.response;
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled check outcome ${JSON.stringify(unhandled)}`);
    }
  }
}

function onlyTheNodeAsked(
  response: CheckResponse,
  request: CheckRequest,
): CheckResponse {
  if (request.node === undefined) return response;

  return {
    ...response,
    nodes: response.nodes.filter((node) => node.node === request.node),
  };
}
