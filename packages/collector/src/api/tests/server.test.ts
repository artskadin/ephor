import { type ApiSettings, createLogger, type Logger } from "@ephorate/core";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../storage/sqlite-storage";
import type { ApiDeps } from "../handlers";
import { createApiServer, MissingTokenError } from "../server";
import { depsOf, NOW, QUEUES, SSH_QUEUES, storageOf } from "./fixtures";

const TOKEN = "0123456789abcdef";

const SETTINGS: ApiSettings = {
  enabled: true,
  bind: "127.0.0.1",
  port: 31_556,
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
        queues: QUEUES,
        ssh: SSH_QUEUES,
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

  describe("PUT and DELETE /api/nodes/:name/ack", () => {
    let storage: SqliteStorage | undefined;
    let now = NOW;

    /** The real storage in memory: the acknowledgement must round-trip. */
    async function ackServer() {
      const opened = new SqliteStorage(":memory:");
      await opened.migrate();
      storage = opened;
      now = NOW;

      return serverOf({
        deps: depsOf([], { storage: opened, now: () => now }),
      });
    }

    afterEach(async () => {
      await storage?.close();
      storage = undefined;
    });

    it("stores one with a note and an end, and the state shows it", async () => {
      const server = await ackServer();

      const put = await server.inject({
        method: "PUT",
        url: "/api/nodes/achilles/ack",
        headers: authorized,
        payload: { note: "  waiting for a new IP  ", duration: "3d" },
      });

      expect(put.statusCode).toBe(200);
      const stored = {
        node: "achilles",
        note: "waiting for a new IP",
        since: NOW,
        until: NOW + 3 * 86_400,
        status: "unknown",
        untilOk: false,
      };
      expect(put.json()).toEqual({ acknowledgement: stored });

      const state = await server.inject({
        method: "GET",
        url: "/api/state",
        headers: authorized,
      });
      expect(state.json().nodes[0].acknowledged).toEqual(stored);
    });

    it("stores the status it acknowledged, and the sticky kind when asked", async () => {
      const server = await ackServer();
      await storage?.write([
        { ts: NOW, node: "achilles", metric: "system.up", ok: false },
      ]);

      const plain = await server.inject({
        method: "PUT",
        url: "/api/nodes/achilles/ack",
        headers: authorized,
      });
      const sticky = await server.inject({
        method: "PUT",
        url: "/api/nodes/achilles/ack",
        headers: authorized,
        payload: { untilOk: true },
      });

      expect(plain.json()).toEqual({
        acknowledgement: {
          node: "achilles",
          since: NOW,
          status: "warn",
          untilOk: false,
        },
      });
      expect(sticky.json().acknowledgement).toMatchObject({
        status: "warn",
        untilOk: true,
      });
    });

    it("refuses a node that is ok: there is nothing to acknowledge", async () => {
      const server = await ackServer();
      await storage?.write([
        { ts: NOW, node: "achilles", metric: "system.up", ok: true },
        { ts: NOW, node: "achilles", metric: "reachability.up", ok: true },
        {
          ts: NOW,
          node: "achilles",
          metric: "reachability.verdict",
          ok: true,
          meta: { verdict: "ok" },
        },
      ]);

      const put = await server.inject({
        method: "PUT",
        url: "/api/nodes/achilles/ack",
        headers: authorized,
      });

      expect(put.statusCode).toBe(409);
      expect(put.json()).toEqual({
        error: "achilles is ok: nothing to acknowledge",
      });
      expect(await storage?.acknowledgements(NOW)).toEqual([]);
    });

    it.each([
      [{ duration: "0s" }, "duration must be between"],
      [{ duration: "400d" }, "duration must be between"],
      [{ duration: "a fortnight" }, "Expected 30, 30s, 15m, 2h or 7d"],
      [{ note: "   " }, "note"],
      [{ note: "two\nlines" }, "note must be one line of plain text"],
      [{ note: "wipe \u001b[2J" }, "note must be one line of plain text"],
      [{ until: 5 }, "until"],
      [{ untilOk: "yes" }, "untilOk"],
    ])("refuses %j with a 400 that says why", async (payload, words) => {
      const server = await ackServer();

      const put = await server.inject({
        method: "PUT",
        url: "/api/nodes/achilles/ack",
        headers: authorized,
        payload,
      });

      expect(put.statusCode).toBe(400);
      expect(put.json().error).toContain(words);
    });

    it("is a 404 for a node that is not configured, both ways", async () => {
      const server = await ackServer();

      for (const method of ["PUT", "DELETE"] as const) {
        const response = await server.inject({
          method,
          url: "/api/nodes/hector/ack",
          headers: authorized,
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: 'unknown node "hector"' });
      }
    });

    it("removes one, answering with it, and then has none to remove", async () => {
      const server = await ackServer();
      await server.inject({
        method: "PUT",
        url: "/api/nodes/achilles/ack",
        headers: authorized,
        payload: { note: "known" },
      });

      const first = await server.inject({
        method: "DELETE",
        url: "/api/nodes/achilles/ack",
        headers: authorized,
      });
      const second = await server.inject({
        method: "DELETE",
        url: "/api/nodes/achilles/ack",
        headers: authorized,
      });

      expect(first.json()).toEqual({
        acknowledgement: {
          node: "achilles",
          note: "known",
          since: NOW,
          status: "unknown",
          untilOk: false,
        },
      });
      expect(second.statusCode).toBe(404);
      expect(second.json()).toEqual({
        error: "achilles has no acknowledgement",
      });
    });

    // Past its end it silenced nothing: removing it is not news.
    it("calls one past its end none, and clears it away", async () => {
      const server = await ackServer();
      await server.inject({
        method: "PUT",
        url: "/api/nodes/achilles/ack",
        headers: authorized,
        payload: { duration: 60 },
      });
      now = NOW + 60;

      const response = await server.inject({
        method: "DELETE",
        url: "/api/nodes/achilles/ack",
        headers: authorized,
      });

      expect(response.statusCode).toBe(404);
      expect(await storage?.expireAcknowledgements(NOW + 60)).toBe(0);
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
