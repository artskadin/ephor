import { timingSafeEqual } from "node:crypto";
import {
  type ApiSettings,
  CheckRequestSchema,
  describeIssues,
  type ErrorResponse,
  type Logger,
  MetricsQuerySchema,
} from "@ephorate/core";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  type ApiDeps,
  getHealth,
  getMetrics,
  getNode,
  getState,
  InvalidQueryError,
  postCheck,
} from "./handlers.js";

// The only file that knows Fastify exists.

interface ApiServerOptions {
  deps: ApiDeps;
  settings: ApiSettings;
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

  // Two loggers would interleave two formats on one stream.
  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (request, reply) => {
    if (matchesToken(request.headers.authorization, options.token)) return;

    options.logger.warn("rejected an unauthenticated API request", {
      method: request.method,
      url: request.url,
      // Never the header: a wrong token is still a secret.
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
    const parsed = MetricsQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      return sendError(reply, 400, describeIssues(parsed.error));
    }

    return getMetrics(options.deps, parsed.data);
  });

  app.post<{ Body: unknown }>("/api/check", async (request, reply) => {
    // No body is the whole fleet: `curl -X POST` sends none.
    const parsed = CheckRequestSchema.safeParse(request.body ?? {});

    if (!parsed.success) {
      return sendError(reply, 400, describeIssues(parsed.error));
    }

    const result = await postCheck(options.deps, parsed.data);
    if (result) return result;

    return sendError(reply, 404, `unknown node "${parsed.data.node}"`);
  });

  app.setNotFoundHandler((_request, reply) =>
    sendError(reply, 404, "not found"),
  );

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof InvalidQueryError) {
      return sendError(reply, 400, error.message);
    }

    const refusal = fastifyRefusal(error);
    if (refusal) return sendError(reply, refusal.status, refusal.message);

    options.logger.error("API request failed", {
      method: request.method,
      url: request.url,
      cause: error,
    });

    // The detail stays in the log, not in a response the caller may publish.
    return sendError(reply, 500, "internal error");
  });

  return app;
}

function sendError(
  reply: FastifyReply,
  status: number,
  message: string,
): FastifyReply {
  const body: ErrorResponse = { error: message };

  return reply.code(status).send(body);
}

// A 4xx Fastify raised itself (`FST_ERR_` code), whose message is the
// caller's to read; a downstream error with a `statusCode` is not.
function fastifyRefusal(
  error: unknown,
): { status: number; message: string } | undefined {
  if (!(error instanceof Error)) return undefined;
  if (!("code" in error) || typeof error.code !== "string") return undefined;
  if (!error.code.startsWith("FST_ERR_")) return undefined;
  if (!("statusCode" in error) || typeof error.statusCode !== "number") {
    return undefined;
  }
  if (error.statusCode < 400 || error.statusCode >= 500) return undefined;

  return { status: error.statusCode, message: error.message };
}

/** Constant time: `===` returns at the first differing character. */
function matchesToken(header: string | undefined, token: string): boolean {
  const prefix = "Bearer ";

  if (header === undefined || !header.startsWith(prefix)) return false;

  const offered = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);

  // timingSafeEqual throws on a length mismatch.
  if (offered.length !== expected.length) return false;

  return timingSafeEqual(offered, expected);
}
