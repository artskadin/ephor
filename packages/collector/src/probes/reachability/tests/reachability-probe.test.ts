import {
  ConfigError,
  HttpRequestError,
  type HttpRequester,
  type ProbeReading,
  parseConfig,
  resolveConfig,
  type Vantage,
} from "@ephorate/core";
import { describe, expect, it } from "vitest";
import {
  ReachabilityProbe,
  reachabilityProbeDescriptor,
} from "../reachability-probe";

const SETTINGS = {
  provider: "check-host.net",
  methods: ["tcp"],
  vantageRefresh: 86_400,
  regions: {
    ru: { match: ["ru"], count: 3, required: true },
    eu: { match: ["de"], count: 3, required: false },
  },
};

function probeThatFailsWith(failure: unknown) {
  const requester: HttpRequester = {
    getJson: () => Promise.reject(failure),
  };

  return new ReachabilityProbe({
    createProvider: () => ({
      id: "fake",
      listVantages: (r) => r.getJson("https://example.test/nodes"),
      probe: () => Promise.resolve([]),
    }),
    requesterFor: () => requester,
  });
}

const CONTEXT = {
  nodeName: "solo",
  host: "203.0.113.10",
  ports: [],
  startedAt: 0,
  timeoutMs: 1000,
  intervalSeconds: 300,
  settings: SETTINGS,
};

describe("reachability error mapping", () => {
  // "the service said no" and "we have a bug" must not land in the metric
  // as the same errorKind.
  it("reports a refused request as a bad response, keeping the status", async () => {
    const outcome = await probeThatFailsWith(
      new HttpRequestError("https://x/", 429, "rate limit reached"),
    ).run(CONTEXT);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toEqual({ kind: "bad_response", status: 429 });
  });

  // No status at all means nothing answered; that one is worth retrying.
  it("reports a request that got no answer as unreachable", async () => {
    const outcome = await probeThatFailsWith(
      new HttpRequestError("https://x/", undefined, "request timed out"),
    ).run(CONTEXT);

    if (outcome.ok) throw new Error("expected a failure");
    expect(outcome.error).toEqual({
      kind: "unreachable",
      detail: "request timed out",
    });
  });

  it("still reports anything else as internal", async () => {
    const outcome = await probeThatFailsWith(
      new TypeError("undefined is not a function"),
    ).run(CONTEXT);

    if (outcome.ok) throw new Error("expected a failure");
    expect(outcome.error.kind).toBe("internal");
  });
});

function vantage(id: string, region: string): Vantage {
  return { id, region, countryCode: region, network: "datacenter" };
}

/** A provider that answers with the given readings, over fixed vantages. */
function probeReading(readings: ProbeReading[]) {
  const vantages = [...new Set(readings.map((reading) => reading.vantage))];

  return new ReachabilityProbe({
    createProvider: () => ({
      id: "fake",
      listVantages: () => Promise.resolve(vantages),
      probe: () => Promise.resolve(readings),
    }),
    requesterFor: () => ({
      getJson: () => Promise.reject(new Error("unused")),
    }),
  });
}

const tcp = (point: Vantage, ok: boolean): ProbeReading => ({
  vantage: point,
  method: "tcp",
  ok,
});

describe("reachability verdict metric", () => {
  // The banned antilochus, measured 2026-09-29: one or two of three RU
  // points reach it. Either way the same kind of problem, not ok.
  it("writes partial with the counts behind it when some RU points fail", async () => {
    const ru = ["ru-1", "ru-2", "ru-3"].map((id) => vantage(id, "ru"));
    const eu = ["de-1", "de-2", "de-3"].map((id) => vantage(id, "eu"));
    const probe = probeReading([
      tcp(ru[0] as Vantage, true),
      tcp(ru[1] as Vantage, true),
      tcp(ru[2] as Vantage, false),
      ...eu.map((point) => tcp(point, true)),
    ]);

    const outcome = await probe.run(CONTEXT);
    if (!outcome.ok) throw new Error("expected a result");

    const verdict = probe
      .toMetrics(outcome.data, CONTEXT)
      .find((point) => point.metric === "reachability.verdict");

    expect(verdict).toMatchObject({
      ok: false,
      meta: {
        verdict: "partial",
        regions: [
          { region: "ru", required: true, method: "tcp", passed: 2, total: 3 },
          { region: "eu", required: false, method: "tcp", passed: 3, total: 3 },
        ],
      },
    });
  });
});

describe("reachability settings", () => {
  it("refuses the removed quorum, saying what replaced it", () => {
    const load = () =>
      parseConfig(
        {
          nodes: [{ name: "solo", host: "203.0.113.10" }],
          probes: { reachability: { quorum: 0.5 } },
        },
        [reachabilityProbeDescriptor],
      );

    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/quorum was removed: a region is ok only when every/);
  });
});

// A metric written but not listed is never shown: the list must be whole,
// and a method or region taken out of the config must leave it.
describe("reachabilityProbeDescriptor.listMetrics", () => {
  const resolvedWith = (reachability: Record<string, unknown>) => {
    const config = parseConfig(
      {
        nodes: [{ name: "solo", host: "203.0.113.10" }],
        probes: { reachability },
      },
      [reachabilityProbeDescriptor],
    );
    const [node] = resolveConfig(config, [reachabilityProbeDescriptor]);
    const resolvedProbe = node?.probes.get("reachability");
    if (resolvedProbe === undefined) throw new Error("expected the probe");

    return resolvedProbe;
  };

  it("lists exactly what a run with every point answering writes", async () => {
    const resolvedProbe = resolvedWith({
      methods: ["ping", "tcp"],
      regions: {
        ru: { match: ["ru"], required: true },
        eu: { match: ["de"] },
      },
    });
    const points = [vantage("ru-1", "ru"), vantage("de-1", "eu")];
    const probe = probeReading(
      points.flatMap((point) =>
        (["ping", "tcp"] as const).map((method) => ({
          vantage: point,
          method,
          ok: true,
        })),
      ),
    );
    const context = { ...CONTEXT, settings: resolvedProbe.settings };

    const outcome = await probe.run(context);
    if (!outcome.ok) throw new Error("expected a result");
    const written = probe
      .toMetrics(outcome.data, context)
      .map((point) => point.metric);

    expect([...resolvedProbe.metrics].sort()).toEqual(written.sort());
  });

  // A method taken out of `methods` is no typo in a threshold; a region
  // that is not configured is.
  it("lets a threshold name any method of a configured region", () => {
    const parse = (metric: string) => () =>
      parseConfig(
        {
          nodes: [{ name: "solo", host: "203.0.113.10" }],
          probes: {
            reachability: {
              methods: ["tcp"],
              regions: { ru: { match: ["ru"], required: true } },
            },
          },
          thresholds: { [metric]: { warn: 1, worseWhen: "below" } },
        },
        [reachabilityProbeDescriptor],
      );

    expect(parse("reachability.ru.ping")).not.toThrow();
    expect(parse("reachability.rus.tcp")).toThrow(
      /Unknown metric "reachability\.rus\.tcp"/,
    );
  });

  it("leaves out a method and a region the config no longer has", () => {
    const resolvedProbe = resolvedWith({
      methods: ["tcp"],
      regions: { ru: { match: ["ru"], required: true } },
    });

    expect([...resolvedProbe.metrics].sort()).toEqual([
      "reachability.ru.tcp",
      "reachability.verdict",
    ]);
  });
});
