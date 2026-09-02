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

/**
 * The shared world, with a fresh `.up` per probe: `/api/state` has rows, and
 * a forced run of the fixture's node has nothing pending.
 */
const serverDeps = (): ApiDeps =>
  depsOf(
    [
      { ts: NOW, node: "achilles", metric: "system.up", ok: true },
      { ts: NOW, node: "achilles", metric: "reachability.up", ok: true },
    ],
    {
      startedAt: NOW - 60,
      runningTasks: () => 0,
    },
  );

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

  describe("POST /api/check", () => {
    it("forces the whole fleet with no body and answers with the state", async () => {
      const response = await serverOf().inject({
        method: "POST",
        url: "/api/check",
        headers: authorized,
      });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(body).toMatchObject({
        now: NOW,
        startedAt: NOW,
        complete: true,
        pending: [],
      });
      expect(body.nodes.map((node: { node: string }) => node.node)).toEqual([
        "achilles",
      ]);
    });

    it("limits the run to what the body names", async () => {
      const deps = serverDeps();
      const forced: [string | undefined, string | undefined][] = [];
      const inner = deps.forceRun;
      deps.forceRun = (node, probe) => {
        forced.push([node, probe]);
        return inner(node, probe);
      };

      const response = await serverOf({ deps }).inject({
        method: "POST",
        url: "/api/check",
        headers: authorized,
        payload: { node: "achilles", probe: "system" },
      });

      expect(response.statusCode).toBe(200);
      expect(forced).toEqual([["achilles", "system"]]);
    });

    it("is a 404 that names the node for one that is not configured", async () => {
      const response = await serverOf().inject({
        method: "POST",
        url: "/api/check",
        headers: authorized,
        payload: { node: "nobody" },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'unknown node "nobody"' });
    });

    it.each([
      [
        "a probe nobody registered",
        { probe: "speed" },
        /unknown probe "speed"/,
      ],
      ["a misspelled key", { nod: "achilles" }, /Unrecognized key/],
      ["a blank node name", { node: "" }, /node/],
    ])(
      "refuses %s with a 400 that says why",
      async (_case, payload, message) => {
        const response = await serverOf().inject({
          method: "POST",
          url: "/api/check",
          headers: authorized,
          payload,
        });

        expect(response.statusCode).toBe(400);
        expect(response.json().error).toMatch(message);
      },
    );

    // Fastify raises these itself, with a status; reporting them as an
    // internal error would send the caller to the collector's log for a
    // mistake in their own request.
    it.each([
      ["a body that is not JSON", "{not json", /JSON/],
      ["an empty body declared as JSON", "", /empty/],
    ])(
      "refuses %s as the caller's mistake",
      async (_case, payload, message) => {
        const response = await serverOf().inject({
          method: "POST",
          url: "/api/check",
          headers: { ...authorized, "content-type": "application/json" },
          payload,
        });

        expect(response.statusCode).toBe(400);
        expect(response.json().error).toMatch(message);
      },
    );
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

  // Only Fastify's own refusals are the caller's. An HTTP client's error
  // carries a `statusCode` too, and its message names the upstream URL.
  it("does not mistake a downstream error with a status for a refusal", async () => {
    const failing = depsOf([], {
      storage: {
        ...storageOf([]),
        latest: async () => {
          throw Object.assign(
            new Error("Not Found: https://internal/v1/state?token=secret"),
            { statusCode: 404 },
          );
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
  });
});
