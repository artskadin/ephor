import { timingSafeEqual } from "node:crypto";
import {
  type ApiSettings,
  type ErrorResponse,
  issueLocation,
  type Logger,
  MetricsQuerySchema,
} from "@ephor/core";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  type ApiDeps,
  getHealth,
  getMetrics,
  getNode,
  getState,
  InvalidQueryError,
} from "./handlers.js";

/**
 * The only file that knows Fastify exists.
 *
 * Everything above it works in plain values: `handlers.ts` builds the
 * answers, `core/api/types.ts` describes their shape. Replacing the framework
 * touches this file and nothing else, and no client can tell.
 */

export interface ApiServerOptions {
  deps: ApiDeps;
  settings: ApiSettings;
  /** Shared secret every request must present. Never empty; see below. */
  token: string;
  logger: Logger;
}

export class MissingTokenError extends Error {
  constructor() {
    super(
      "EPHOR_TOKEN is not set. The API serves the state of every node, and " +
        "on a host shared with anything else — a panel, another operator — " +
        '"listening on 127.0.0.1" means "readable by everyone with a shell ' +
        'here". Generate one with `openssl rand -hex 32` and export it, or ' +
        "set api.enabled: false to run the collector without an API.",
    );
    this.name = "MissingTokenError";
  }
}

export function createApiServer(options: ApiServerOptions): FastifyInstance {
  if (options.token === "") throw new MissingTokenError();

  // Fastify keeps its own logger; ours is the one the rest of the collector
  // writes to, and two of them would interleave two formats on one stream.
  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (request, reply) => {
    if (matchesToken(request.headers.authorization, options.token)) return;

    options.logger.warn("rejected an unauthenticated API request", {
      method: request.method,
      url: request.url,
      // The address only, never the header: logging a wrong token still
      // logs a secret, and the near-misses are the ones worth stealing.
      from: request.ip,
    });

    await sendError(reply, 401, "unauthorized");
  });

  app.get("/api/health", () => getHealth(options.deps));
  app.get("/api/state", () => getState(options.deps));

  app.get<{ Params: { name: string } }>(
    "/api/nodes/:name",
    async (request, reply) => {
      const found = await getNode(options.deps, request.params.name);
      if (found) return found;

      return sendError(reply, 404, `unknown node "${request.params.name}"`);
    },
  );

  app.get("/api/metrics", async (request, reply) => {
    // Parsed here, in the one file that knows about HTTP, so the handler
    // receives typed values and the schema's messages reach the caller.
    const parsed = MetricsQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      return sendError(
        reply,
        400,
        parsed.error.issues
          .map((issue) => `${issueLocation(issue)}: ${issue.message}`)
          .join("; "),
      );
    }

    return getMetrics(options.deps, parsed.data);
  });

  app.setNotFoundHandler((_request, reply) =>
    sendError(reply, 404, "not found"),
  );

  app.setErrorHandler(async (error, request, reply) => {
    // The one failure that is the caller's: it parsed, and it still cannot
    // be answered as asked.
    if (error instanceof InvalidQueryError) {
      return sendError(reply, 400, error.message);
    }

    options.logger.error("API request failed", {
      method: request.method,
      url: request.url,
      cause: error,
    });

    // Deliberately bare: the detail is in the collector's log, where the
    // operator can read it, and not in a response the caller might publish.
    return sendError(reply, 500, "internal error");
  });

  return app;
}

/**
 * Every failure leaves through here, so every failure has the one shape.
 * `send()` hands back the reply itself, which is thenable, so callers may
 * `await` or `return` it alike.
 */
function sendError(
  reply: FastifyReply,
  status: number,
  message: string,
): FastifyReply {
  const body: ErrorResponse = { error: message };

  return reply.code(status).send(body);
}

/**
 * Compared byte by byte in constant time. A plain `===` returns as soon as
 * two characters differ, and the time it took says how many were right —
 * enough, over many tries, to recover the token one character at a time.
 */
function matchesToken(header: string | undefined, token: string): boolean {
  const prefix = "Bearer ";

  if (header === undefined || !header.startsWith(prefix)) return false;

  const offered = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);

  // timingSafeEqual throws on a length mismatch, which would leak the length
  // through the error rather than the timing. Answering false is what the
  // caller gets anyway.
  if (offered.length !== expected.length) return false;

  return timingSafeEqual(offered, expected);
}
