import { checkWithoutDaemon, createRegistry } from "@ephorate/collector";
import {
  type CheckRequest,
  type CheckResponse,
  ConfigError,
  type Logger,
  loadConfig,
} from "@ephorate/core";
import { UsageError } from "../exit-code.js";
import { stateText } from "../render/state-text.js";

interface CheckOptions {
  configPath: string;
  request: CheckRequest;
  json: boolean;
  colour: boolean;
  logger: Logger;
  /** Stdout is the data channel; everything for a person goes to stderr. */
  print: (line: string) => void;
  note: (line: string) => void;
}

/**
 * The probes once, in this process, over a database in memory: the same
 * scheduler as `serve`, nothing recorded. Returning is the whole answer.
 */
export async function runCheck(options: CheckOptions): Promise<void> {
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
      options.print(
        await stateText(
          // JSON keeps the API's shape, every node; the table shows what
          // was asked for, the rest "has not reported yet".
          options.json
            ? outcome.response
            : onlyTheNodeAsked(outcome.response, request),
          options,
        ),
      );
      return;
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
