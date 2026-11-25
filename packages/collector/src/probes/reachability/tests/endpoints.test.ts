import {
  buildNodeState,
  createLogger,
  type HttpRequester,
  type ProbeContext,
  type ProbeReading,
  parseConfig,
  type ReachabilityTarget,
  resolveConfig,
  type Vantage,
} from "@ephorate/core";
import { describe, expect, it, vi } from "vitest";
import { Collector } from "../../../collector";
import { CheckHostProvider } from "../../../reachability/check-host-provider";
import { ProviderResponseError } from "../../../reachability/provider-response-error";
import { SqliteStorage } from "../../../storage/sqlite-storage";
import { ProbeRegistry } from "../../registry";
import { systemProbeDescriptor } from "../../system/system-probe";
import {
  ReachabilityProbe,
  reachabilityProbeDescriptor,
} from "../reachability-probe";

const HOST = "203.0.113.10";
const PUBLIC_URL = "https://vpn.example.com:9443/connect";
const VANTAGES: Vantage[] = [
  { id: "ru-1", region: "ru", countryCode: "ru", network: "datacenter" },
  { id: "de-1", region: "eu", countryCode: "de", network: "datacenter" },
];
const REGIONS = {
  ru: { match: ["ru"], required: true },
  eu: { match: ["de"], required: false },
};
const DESCRIPTORS = [systemProbeDescriptor, reachabilityProbeDescriptor];

function probeFor(
  read: (target: ReachabilityTarget) => ProbeReading[],
  vantages = VANTAGES,
) {
  return new ReachabilityProbe({
    createProvider: () => ({
      id: "fixture",
      listVantages: async () => vantages,
      probe: async ({ target }) => read(target),
    }),
    requesterFor: () => ({
      getJson: () => Promise.reject(new Error("no network in this test")),
    }),
  });
}

function nodeWith(fields: Record<string, unknown> = {}) {
  return {
    name: "gateway",
    host: HOST,
    ssh: { user: "monitor", port: 2222 },
    ...fields,
  };
}

function configuredNode(
  endpoints: unknown,
  ports: number[] = [],
  thresholds?: Record<string, unknown>,
) {
  const config = parseConfig(
    {
      nodes: [nodeWith({ endpoints, ports })],
      probes: { reachability: { regions: REGIONS } },
      thresholds,
    },
    DESCRIPTORS,
  );
  const [node] = resolveConfig(config, DESCRIPTORS);
  const settings = node?.probes.get("reachability")?.settings;
  if (node === undefined || settings === undefined) {
    throw new Error("expected reachability settings");
  }
  const context: ProbeContext = {
    nodeName: node.config.name,
    host: node.config.host,
    endpoints: node.config.endpoints,
    ports: node.config.ports,
    startedAt: 10,
    timeoutMs: 1000,
    intervalSeconds: 300,
    settings,
  };
  return { node, context };
}

function reading(
  target: ReachabilityTarget,
  vantage: Vantage,
  ok: boolean,
): ProbeReading {
  return { vantage, method: target.method, ok };
}

describe("endpoint configuration", () => {
  it("validates a node threshold against its own endpoints, but global thresholds against the fleet", () => {
    const metric = "reachability.endpoint.other.ru.tcp";
    const thresholds = { [metric]: { warn: 0.5, worseWhen: "below" } };
    const nodes = [
      nodeWith({ endpoints: { vpn: { tcp: 443 } } }),
      nodeWith({ name: "other-node", endpoints: { other: { tcp: 8443 } } }),
    ];
    const probes = { reachability: { regions: REGIONS } };
    expect(() =>
      parseConfig({ probes, nodes, thresholds }, DESCRIPTORS),
    ).not.toThrow();
    expect(() =>
      parseConfig(
        { probes, nodes: [nodes[0], { ...nodes[1], thresholds }] },
        DESCRIPTORS,
      ),
    ).not.toThrow();
    expect(() =>
      parseConfig(
        { probes, nodes: [{ ...nodes[0], thresholds }, nodes[1]] },
        DESCRIPTORS,
      ),
    ).toThrow(
      /node gateway: thresholds[\s\S]*Unknown metric "reachability\.endpoint\.other\.ru\.tcp"/,
    );
  });

  it.each([
    { location: "globally", probes: { reachability: {} }, nodeProbes: {} },
    { location: "on the node", probes: {}, nodeProbes: { reachability: {} } },
  ])(
    "requires a named node to declare an endpoint when reachability is enabled $location",
    ({ probes, nodeProbes }) => {
      expect(() =>
        parseConfig(
          {
            probes,
            nodes: [nodeWith({ ports: [443], probes: nodeProbes })],
          },
          DESCRIPTORS,
        ),
      ).toThrow(
        /node gateway: endpoints[\s\S]*add `endpoints: \{ vpn: \{ tcp: 443 \} \}`/,
      );
    },
  );

  it("does not take methods or domain from the old config", () => {
    const configWith = (methods: unknown, domain: unknown) =>
      parseConfig(
        {
          probes: {
            reachability: {
              regions: REGIONS,
              ...(methods === undefined ? {} : { methods }),
            },
          },
          nodes: [
            nodeWith({
              endpoints: { vpn: { tcp: 443 } },
              ...(domain === undefined ? {} : { domain }),
            }),
          ],
        },
        DESCRIPTORS,
      );
    expect(() => configWith(["tcp"], undefined)).toThrow(
      /Unrecognized key: "methods"/,
    );
    expect(() => configWith(undefined, "vpn.example.com")).toThrow(
      /Unrecognized key: "domain"/,
    );
  });

  it("does not require endpoints for a node with only system enabled", () => {
    expect(() =>
      parseConfig(
        {
          probes: { system: {}, reachability: {} },
          nodes: [nodeWith({ probes: { reachability: { enabled: false } } })],
        },
        DESCRIPTORS,
      ),
    ).not.toThrow();
  });

  it.each([
    {},
    { vpn: { tcp: 443, udp: 443 } },
    { vpn: { tcp: 0 } },
    { vpn: { udp: 65_536 } },
    { vpn: { https: "http://vpn.example.com/" } },
    { vpn: { https: "https://name:secret@vpn.example.com/" } },
    { vpn: { https: "https://vpn.example.com/#fragment" } },
  ])("rejects invalid endpoint settings (%j)", (endpoints) => {
    expect(() => configuredNode(endpoints)).toThrow(/node gateway: endpoints/);
  });
});

function collectorFor(
  storage: SqliteStorage,
  requester: HttpRequester,
  regions: Record<string, { match: string[]; required: boolean }> = REGIONS,
) {
  let providerNowMs = 0;
  const registry = new ProbeRegistry();
  registry.register(
    new ReachabilityProbe({
      requesterFor: () => requester,
      createProvider: (settings) =>
        new CheckHostProvider({
          regions: settings.regions,
          vantageTtlMs: 60_000,
          pollIntervalMs: 1,
          pollTimeoutMs: 1,
          now: () => providerNowMs,
          sleep: async (ms) => {
            providerNowMs += ms;
          },
        }),
    }),
  );
  const config = parseConfig(
    {
      nodes: [
        {
          name: "gateway",
          host: HOST,
          endpoints: { vpn: { tcp: 443 }, site: { https: PUBLIC_URL } },
        },
      ],
      probes: { reachability: { regions } },
    },
    registry.descriptors(),
  );
  return new Collector({
    config,
    registry,
    storage,
    logger: createLogger({ level: "silent" }),
  });
}

function checkHostFixture() {
  const nodes = {
    ru: { location: ["ru", "Russia", "Fixture"] },
    eu: { location: ["de", "Germany", "Fixture"] },
  };
  let allFail = false;
  const requester: HttpRequester = {
    async getJson<T>(url: string): Promise<T> {
      switch (new URL(url).pathname) {
        case "/nodes/hosts":
          return { nodes } as T;
        case "/check-tcp":
          return { nodes, request_id: "tcp" } as T;
        case "/check-http":
          return { nodes, request_id: "http" } as T;
        case "/check-result/tcp":
          return (
            allFail
              ? { ru: [{}], eu: [{ time: 0.02 }] }
              : { ru: [{ time: 0.01 }], eu: [{ time: 0.02 }] }
          ) as T;
        case "/check-result/http":
          return (
            allFail
              ? { ru: null, eu: null }
              : { ru: [[1, 0.01]], eu: [[1, 0.02]] }
          ) as T;
        default:
          throw new Error("unexpected request to the offline provider fixture");
      }
    },
  };
  return {
    requester,
    failAll: () => {
      allFail = true;
    },
  };
}

describe("endpoint history in the collector", () => {
  it("records every failed attempt and keeps both last verdicts when all endpoints fail", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const storage = new SqliteStorage(":memory:");
    const { requester, failAll } = checkHostFixture();
    const collector = collectorFor(storage, requester);
    const state = async () =>
      buildNodeState({
        nodes: collector.nodes,
        points: await storage.latest(),
        now: Date.now() / 1000,
      })[0];
    try {
      await storage.migrate();
      await collector.runNow().finished;
      expect(await state()).toMatchObject({ status: "ok", reachability: "ok" });
      failAll();
      clock.mockReturnValue(1_800_000_020_000);
      await collector.runNow().finished;
      expect(await state()).toMatchObject({
        status: "warn",
        reachability: "unknown",
        endpoints: [
          {
            name: "vpn",
            verdict: "ok",
            ageSeconds: 20,
            error:
              "bad_response: check-host.net returned an invalid TCP result",
          },
          {
            name: "site",
            verdict: "ok",
            ageSeconds: 20,
            error: "bad_response: no selected point reported a result",
          },
        ],
      });
      const failedRun = await storage.query({
        node: "gateway",
        from: 1_800_000_020,
      });
      expect(failedRun).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ metric: "reachability.up", ok: false }),
          expect.objectContaining({
            metric: "reachability.endpoint.vpn.attempt",
            ok: false,
            meta: expect.objectContaining({
              error: expect.stringContaining("invalid TCP result"),
            }),
          }),
          expect.objectContaining({
            metric: "reachability.endpoint.site.attempt",
            ok: false,
            meta: expect.objectContaining({
              error: expect.stringContaining("no selected point reported"),
            }),
          }),
        ]),
      );
      expect(failedRun).toHaveLength(3);
    } finally {
      clock.mockRestore();
      collector.stop();
      await storage.close();
    }
  });

  it("does not reuse endpoint evidence after adding a required region", async () => {
    const storage = new SqliteStorage(":memory:");
    const { requester } = checkHostFixture();
    const before = collectorFor(storage, requester);
    const after = collectorFor(storage, requester, {
      ...REGIONS,
      kz: { match: ["kz"], required: true },
    });
    try {
      await storage.migrate();
      await before.runNow().finished;
      const points = await storage.latest();
      const now = Math.floor(Date.now() / 1000);
      expect(
        buildNodeState({ nodes: before.nodes, points, now })[0]?.reachability,
      ).toBe("ok");
      expect(
        buildNodeState({ nodes: after.nodes, points, now })[0],
      ).toMatchObject({
        status: "unknown",
        reachability: "unknown",
        endpoints: [
          { name: "vpn", verdict: null },
          { name: "site", verdict: null },
        ],
      });
      expect(
        await storage.query({
          node: "gateway",
          metric: "reachability.endpoint.vpn.verdict",
        }),
      ).toEqual([
        expect.objectContaining({
          meta: expect.objectContaining({ verdict: "ok" }),
        }),
      ]);
    } finally {
      before.stop();
      after.stop();
      await storage.close();
    }
  });
});

describe("explicit endpoint measurements", () => {
  it.each([
    { port: 443, ports: [8443, 443] },
    { port: 8443, ports: [8443, 443] },
    { port: 443, ports: [443, 8443] },
    { port: 8443, ports: [443, 8443] },
  ])(
    "checks explicit TCP $port with listeners $ports",
    async ({ port, ports }) => {
      const { context } = configuredNode({ vpn: { tcp: port } }, ports);
      const destinations: ReachabilityTarget[] = [];
      const probe = probeFor((target) => {
        destinations.push(target);
        return VANTAGES.map((point) => reading(target, point, true));
      });
      expect((await probe.run(context)).ok).toBe(true);
      expect(destinations).toEqual([{ method: "tcp", host: HOST, port }]);
    },
  );

  it("keeps HTTPS, TCP and an unmeasured UDP endpoint distinct", async () => {
    const { node, context } = configuredNode(
      {
        vpn: { tcp: 443 },
        site: { https: PUBLIC_URL },
        direct: { udp: 51820 },
      },
      [8443, 443],
    );
    const destinations: ReachabilityTarget[] = [];
    const probe = probeFor((target) => {
      destinations.push(target);
      return VANTAGES.map((point) =>
        reading(
          target,
          point,
          target.method === "tcp" || point.region === "eu",
        ),
      );
    });
    const outcome = await probe.run(context);
    if (!outcome.ok) throw new Error("expected endpoint observations");
    expect(destinations).toEqual([
      { method: "tcp", host: HOST, port: 443 },
      { method: "http", url: PUBLIC_URL },
    ]);
    const points = probe.toMetrics(outcome.data, context);
    const [state] = buildNodeState({ nodes: [node], points, now: 11 });
    expect(state).toMatchObject({
      reachability: "blocked",
      status: "critical",
      endpoints: [
        { name: "vpn", verdict: "ok" },
        { name: "site", destination: PUBLIC_URL, verdict: "blocked" },
        {
          name: "direct",
          status: "unknown",
          verdict: null,
          reason: "UDP checks are not supported",
        },
      ],
    });
  });

  it("keeps a good sibling visible when another endpoint returns invalid evidence", async () => {
    const { node, context } = configuredNode({
      vpn: { tcp: 443 },
      site: { https: PUBLIC_URL },
    });
    const probe = probeFor((target) => {
      if (target.method === "http")
        throw new ProviderResponseError("invalid endpoint result");
      return VANTAGES.map((point) => reading(target, point, true));
    });
    const outcome = await probe.run(context);
    if (!outcome.ok) throw new Error("expected the good sibling's result");
    const points = probe.toMetrics(outcome.data, context);
    expect(buildNodeState({ nodes: [node], points, now: 11 })[0]).toMatchObject(
      {
        reachability: "unknown",
        status: "warn",
        endpoints: [
          { name: "vpn", verdict: "ok" },
          {
            name: "site",
            verdict: null,
            error: "bad_response: invalid endpoint result",
          },
        ],
      },
    );
  });

  it("does not create a provider on a UDP-only node", async () => {
    const { node, context } = configuredNode({ vpn: { udp: 51820 } }, [443]);
    const probe = new ReachabilityProbe({
      createProvider: () => {
        throw new Error("UDP must not contact a provider");
      },
      requesterFor: () => {
        throw new Error("UDP must not request any measurement");
      },
    });
    const outcome = await probe.run(context);
    if (!outcome.ok) throw new Error("expected an unmeasured endpoint");
    const points = probe.toMetrics(outcome.data, context);
    expect(buildNodeState({ nodes: [node], points, now: 11 })[0]).toMatchObject(
      {
        status: "unknown",
        endpoints: [
          {
            name: "vpn",
            verdict: null,
            reason: "UDP checks are not supported",
          },
        ],
      },
    );
  });

  it("does not carry observations over to a changed port with the same name", async () => {
    const before = configuredNode({ vpn: { tcp: 443 } }, [443, 8443]);
    const after = configuredNode({ vpn: { tcp: 8443 } }, [443, 8443]);
    const probe = probeFor((target) =>
      VANTAGES.map((point) => reading(target, point, true)),
    );
    const outcome = await probe.run(before.context);
    if (!outcome.ok) throw new Error("expected an endpoint observation");
    const points = probe.toMetrics(outcome.data, before.context);
    const [oldState, newState] = buildNodeState({
      nodes: [before.node, after.node],
      points,
      now: 11,
    });
    expect(oldState).toMatchObject({
      status: "ok",
      endpoints: [{ verdict: "ok" }],
    });
    expect(newState).toMatchObject({
      status: "unknown",
      reachability: "unknown",
      metrics: [],
      endpoints: [{ name: "vpn", destination: `${HOST}:8443`, verdict: null }],
    });
  });

  it("keeps an unchanged endpoint's evidence when adding an unsupported sibling", async () => {
    const before = configuredNode({ vpn: { tcp: 443 } });
    const after = configuredNode({ vpn: { tcp: 443 }, direct: { udp: 51820 } });
    const probe = probeFor((target) =>
      VANTAGES.map((point) => reading(target, point, true)),
    );
    const outcome = await probe.run(before.context);
    if (!outcome.ok) throw new Error("expected an endpoint observation");
    const points = probe.toMetrics(outcome.data, before.context);
    const [state] = buildNodeState({ nodes: [after.node], points, now: 11 });
    expect(state).toMatchObject({
      status: "unknown",
      reachability: "unknown",
      endpoints: [
        { name: "vpn", verdict: "ok" },
        { name: "direct", verdict: null },
      ],
    });
  });

  it("does not erase a measured outage when a later attempt fails and a sibling succeeds", async () => {
    const { node, context } = configuredNode({
      vpn: { tcp: 443 },
      site: { https: PUBLIC_URL },
    });
    let malformed = false;
    const probe = probeFor((target) => {
      if (malformed && target.method === "tcp")
        throw new ProviderResponseError("invalid TCP result");
      return VANTAGES.map((point) =>
        reading(target, point, target.method === "http"),
      );
    });
    const storage = new SqliteStorage(":memory:");
    try {
      await storage.migrate();
      const first = await probe.run(context);
      if (!first.ok) throw new Error("expected measured failure");
      await storage.write(probe.toMetrics(first.data, context));

      malformed = true;
      const retry = { ...context, startedAt: 20 };
      const second = await probe.run(retry);
      if (!second.ok)
        throw new Error("expected the other endpoint's measurement");
      await storage.write(probe.toMetrics(second.data, retry));

      const points = await storage.latest();
      const [state] = buildNodeState({ nodes: [node], points, now: 21 });
      expect(state).toMatchObject({
        status: "critical",
        reachability: "down",
        endpoints: [
          {
            name: "vpn",
            verdict: "down",
            ageSeconds: 11,
            error: "bad_response: invalid TCP result",
          },
          { name: "site", verdict: "ok", ageSeconds: 1 },
        ],
      });
    } finally {
      await storage.close();
    }
  });

  it("keeps an unchanged endpoint's regional threshold when a sibling URL changes", async () => {
    const thresholds = {
      "reachability.endpoint.vpn.ru.tcp": {
        critical: 0.75,
        worseWhen: "below",
      },
    };
    const endpoints = { vpn: { tcp: 443 }, site: { https: PUBLIC_URL } };
    const before = configuredNode(endpoints, [], thresholds);
    const after = configuredNode(
      { ...endpoints, site: { https: `${PUBLIC_URL}/new` } },
      [],
      thresholds,
    );
    const vantages: Vantage[] = [
      ...VANTAGES,
      { id: "ru-2", region: "ru", countryCode: "ru", network: "datacenter" },
    ];
    const probe = probeFor(
      (target) =>
        vantages.map((point) =>
          reading(
            target,
            point,
            point.id !== "ru-2" || target.method === "http",
          ),
        ),
      vantages,
    );
    const outcome = await probe.run(before.context);
    if (!outcome.ok) throw new Error("expected measurements");
    const points = probe.toMetrics(outcome.data, before.context);
    const [state] = buildNodeState({ nodes: [after.node], points, now: 11 });
    expect(state).toMatchObject({
      status: "critical",
      endpoints: [
        { name: "vpn", verdict: "partial" },
        { name: "site", verdict: null },
      ],
    });
    expect(state?.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "reachability.endpoint.vpn.ru.tcp",
          breached: "critical",
        }),
      ]),
    );
  });

  it("treats an endpoint with no reported observations as a measurement error", async () => {
    const { context } = configuredNode({ vpn: { tcp: 443 } });
    const probe = probeFor((target) =>
      VANTAGES.map((point) => ({
        ...reading(target, point, false),
        observed: false,
      })),
    );
    expect(await probe.run(context)).toMatchObject({
      ok: false,
      error: {
        kind: "bad_response",
        detail: "no selected point reported a result",
      },
    });
  });

  it("shows a stale outage in endpoint details but not as the current node verdict", async () => {
    const { node, context } = configuredNode({
      vpn: { tcp: 443 },
      site: { https: PUBLIC_URL },
    });
    const probe = probeFor((target) =>
      VANTAGES.map((point) => reading(target, point, target.method === "http")),
    );
    const outcome = await probe.run(context);
    if (!outcome.ok) throw new Error("expected measurements");
    const points = probe
      .toMetrics(outcome.data, context)
      .map((point) =>
        point.metric.startsWith("reachability.endpoint.site.")
          ? { ...point, ts: 701 }
          : point,
      );
    const [state] = buildNodeState({ nodes: [node], points, now: 702 });
    expect(state).toMatchObject({
      status: "stale",
      reachability: "unknown",
      endpoints: [
        { name: "vpn", status: "stale", verdict: "down" },
        { name: "site", status: "ok", verdict: "ok" },
      ],
    });
  });
});
