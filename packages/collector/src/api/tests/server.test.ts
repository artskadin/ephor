import { type ApiSettings, createLogger, type Logger } from "@ephor/core";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiDeps } from "../handlers.js";
import { createApiServer, MissingTokenError } from "../server.js";
import { depsOf, NOW, storageOf } from "./fixtures.js";

const TOKEN = "0123456789abcdef";

const SETTINGS: ApiSettings = {
  enabled: true,
  bind: "127.0.0.1",
  port: 53_556,
};

const silent = (): Logger => createLogger({ level: "silent" });

/** The shared world, with one fresh point so `/api/state` has a row. */
const serverDeps = (): ApiDeps =>
  depsOf([{ ts: NOW, node: "achilles", metric: "system.up", ok: true }], {
    startedAt: NOW - 60,
    runningTasks: () => 0,
  });

let app: FastifyInstance | undefined;

function serverOf(options: { token?: string; deps?: ApiDeps } = {}) {
  app = createApiServer({
    deps: options.deps ?? serverDeps(),
    settings: SETTINGS,
    token: options.token ?? TOKEN,
    logger: silent(),
  });

  return app;
}

const authorized = { authorization: `Bearer ${TOKEN}` };

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("createApiServer", () => {
  // Losing the API entirely is recoverable; serving the state of every node
  // to whoever else has a shell on the bastion is not.
  it("refuses to exist without a token", () => {
    expect(() => serverOf({ token: "" })).toThrow(MissingTokenError);
  });

  it("explains how to make one", () => {
    expect(() => serverOf({ token: "" })).toThrow(/openssl rand/);
  });

  describe("authentication", () => {
    it.each([
      ["no header at all", undefined],
      ["a bare token without the scheme", TOKEN],
      ["the wrong token", "Bearer 0123456789abcdee"],
      ["a token that is a prefix of the right one", "Bearer 0123456789abcde"],
      ["a token that extends the right one", `Bearer ${TOKEN}0`],
      ["another scheme", `Basic ${TOKEN}`],
    ])("rejects %s", async (_case, header) => {
      const response = await serverOf().inject({
        method: "GET",
        url: "/api/health",
        ...(header === undefined ? {} : { headers: { authorization: header } }),
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "unauthorized" });
    });

    it("accepts the right token", async () => {
      const response = await serverOf().inject({
        method: "GET",
        url: "/api/health",
        headers: authorized,
      });

      expect(response.statusCode).toBe(200);
    });

    // An unauthenticated caller must not be able to tell which routes exist.
    it("checks the token before the route", async () => {
      const response = await serverOf().inject({
        method: "GET",
        url: "/api/no-such-thing",
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe("GET /api/health", () => {
    it("reports uptime and what is being watched", async () => {
      const response = await serverOf().inject({
        method: "GET",
        url: "/api/health",
        headers: authorized,
      });

      expect(response.json()).toEqual({
        ok: true,
        uptimeSeconds: 60,
        runningTasks: 0,
        nodes: 1,
        probes: ["system", "reachability"],
      });
    });
  });

  describe("GET /api/state", () => {
    it("returns the collector's clock and one entry per node", async () => {
      const response = await serverOf().inject({
        method: "GET",
        url: "/api/state",
        headers: authorized,
      });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(body.now).toBe(NOW);
      expect(body.nodes.map((node: { node: string }) => node.node)).toEqual([
        "achilles",
      ]);
    });
  });

  describe("GET /api/nodes/:name", () => {
    it("returns the one node", async () => {
      const response = await serverOf().inject({
        method: "GET",
        url: "/api/nodes/achilles",
        headers: authorized,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().node.node).toBe("achilles");
      expect(response.json().now).toBe(NOW);
    });

    it("is a 404 that names the node for one that is not configured", async () => {
      const response = await serverOf().inject({
        method: "GET",
        url: "/api/nodes/nobody",
        headers: authorized,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'unknown node "nobody"' });
    });
  });

  describe("GET /api/metrics", () => {
    it("answers with the window and limit it applied", async () => {
      const response = await serverOf().inject({
        method: "GET",
        url: "/api/metrics?node=achilles",
        headers: authorized,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        truncated: false,
        from: NOW - 3600,
        to: NOW,
        limit: 1000,
      });
    });

    // The same rule the config follows: a misspelled key must not quietly
    // widen the query to everything.
    it.each([
      ["a misspelled key", "nod=achilles", /Unrecognized key/],
      ["from later than to", "from=200&to=100", /from must not be later/],
      ["a limit of zero", "limit=0", /limit/],
      ["a limit past the maximum", "limit=10001", /limit/],
      ["a non-numeric time", "from=yesterday", /from/],
      // `Number("")` is 0: without an explicit refusal a blank field would
      // read as "since the epoch" and return the node's entire history.
      ["a blank time", "from=", /from: expected a whole number/],
      ["a negative time", "from=-1", /from/],
      ["a time in exponent notation", "from=1e3", /from/],
      // Only one bound given, so the schema cannot compare; the handler
      // must, once it has filled in `to`.
      [
        "a from later than the defaulted to",
        "from=4000000000",
        /from must not be later than to/,
      ],
    ])("refuses %s with a 400 that says why", async (_case, query, message) => {
      const response = await serverOf().inject({
        method: "GET",
        url: `/api/metrics?${query}`,
        headers: authorized,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(message);
    });
  });

  it("answers an unknown route in the same shape as any other failure", async () => {
    const response = await serverOf().inject({
      method: "GET",
      url: "/api/nope",
      headers: authorized,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not found" });
  });

  // The detail belongs in the collector's log, where the operator reads it,
  // not in a response that might be pasted into an issue.
  it("does not leak the cause of an internal failure", async () => {
    const failing = depsOf([], {
      storage: {
        ...storageOf([]),
        latest: async () => {
          throw new Error("database is locked, /srv/ephor/metrics.db");
        },
      },
    });

    const response = await serverOf({ deps: failing }).inject({
      method: "GET",
      url: "/api/state",
      headers: authorized,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal error" });
    expect(response.body).not.toContain("metrics.db");
  });
});
