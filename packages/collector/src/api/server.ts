import { timingSafeEqual } from "node:crypto";
import type { ApiSettings, ErrorResponse, Logger } from "@ephor/core";
import Fastify, { type FastifyInstance } from "fastify";
import { type ApiDeps, getHealth, getState } from "./handlers.js";

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

    const body: ErrorResponse = { error: "unauthorized" };
    await reply.code(401).send(body);
  });

  app.get("/api/health", () => getHealth(options.deps));
  app.get("/api/state", () => getState(options.deps));

  app.setNotFoundHandler(async (_request, reply) => {
    const body: ErrorResponse = { error: "not found" };
    await reply.code(404).send(body);
  });

  app.setErrorHandler(async (error, request, reply) => {
    options.logger.error("API request failed", {
      method: request.method,
      url: request.url,
      cause: error,
    });

    // Deliberately bare: the detail is in the collector's log, where the
    // operator can read it, and not in a response the caller might publish.
    const body: ErrorResponse = { error: "internal error" };
    await reply.code(500).send(body);
  });

  return app;
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
