import {
  type ApiSettings,
  createLogger,
  type Logger,
  type MetricPoint,
  parseConfig,
  type QueryFilter,
  resolveConfig,
  type Storage,
} from "@ephor/core";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { reachabilityProbeDescriptor } from "../../probes/reachability/reachability-probe.js";
import { systemProbeDescriptor } from "../../probes/system/system-probe.js";
import type { ApiDeps } from "../handlers.js";
import { createApiServer, MissingTokenError } from "../server.js";

const TEST_PROBES = [systemProbeDescriptor, reachabilityProbeDescriptor];
const NOW = 1_800_000_000;
const TOKEN = "0123456789abcdef";

const SETTINGS: ApiSettings = {
  enabled: true,
  bind: "127.0.0.1",
  port: 53_556,
};

const silent = (): Logger => createLogger({ level: "silent" });

function storageOf(points: readonly MetricPoint[]): Storage {
  return {
    migrate: async () => {},
    write: async () => {},
    query: async (_filter: QueryFilter) => [],
    latest: async () => [...points],
    prune: async () => 0,
    close: async () => {},
  };
}

function depsOf(overrides: Partial<ApiDeps> = {}): ApiDeps {
  const config = parseConfig(
    { nodes: [{ name: "achilles", host: "203.0.113.10", ssh: "achilles" }] },
    TEST_PROBES,
  );

  return {
    storage: storageOf([
      { ts: NOW, node: "achilles", metric: "system.up", ok: true },
    ]),
    nodes: resolveConfig(config, TEST_PROBES),
    probeNames: TEST_PROBES.map((probe) => probe.name),
    now: () => NOW,
    startedAt: NOW - 60,
    runningTasks: () => 0,
    ...overrides,
  };
}

let app: FastifyInstance | undefined;

function serverOf(options: { token?: string; deps?: ApiDeps } = {}) {
  app = createApiServer({
    deps: options.deps ?? depsOf(),
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
    const failing = depsOf({
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
