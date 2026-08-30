import type { HttpRequester, ProbeReading, Vantage } from "@ephor/core";
import { describe, expect, it } from "vitest";
import { CheckHostProvider } from "../check-host-provider.js";
import type { Region } from "../settings.js";

/**
 * Answers from a script of canned responses, recording what was asked. Time
 * is injected too, so polling is exercised without any real waiting.
 */
class ScriptedRequester implements HttpRequester {
  readonly urls: string[] = [];

  constructor(
    private readonly answer: (url: string, call: number) => unknown,
  ) {}

  async getJson<T>(url: string): Promise<T> {
    const call = this.urls.length;
    this.urls.push(url);

    const response = this.answer(url, call);

    if (response instanceof Error) throw response;

    return response as T;
  }
}

/** Two Moscow nodes, one in Berlin, one in Lisbon. */
const NODES_RESPONSE = {
  nodes: {
    "ru1.node.check-host.net": {
      asn: "AS1",
      ip: "1.1.1.1",
      location: ["ru", "Russia", "Moscow"],
    },
    "ru2.node.check-host.net": {
      asn: "AS2",
      ip: "1.1.1.2",
      location: ["ru", "Russia", "Moscow"],
    },
    "de1.node.check-host.net": {
      asn: "AS3",
      ip: "1.1.1.3",
      location: ["de", "Germany", "Berlin"],
    },
    "pt1.node.check-host.net": {
      asn: "AS4",
      ip: "1.1.1.4",
      location: ["pt", "Portugal", "Lisbon"],
    },
  },
};

const REGIONS: Record<string, Region> = {
  ru: { match: ["ru"], count: 4, required: true },
  eu: { match: ["de", "pt"], count: 1, required: false },
};

/**
 * Time is always injected. With a zero poll interval and a real clock, a
 * check whose results never complete would spin until the deadline — the
 * clock has to move in step with the fake sleep, not independently of it.
 */
function providerWith(
  answer: (url: string, call: number) => unknown,
  overrides: { now?: () => number; vantageTtlMs?: number } = {},
) {
  const requester = new ScriptedRequester(answer);
  let clock = 1_000_000;

  const provider = new CheckHostProvider({
    regions: REGIONS,
    vantageTtlMs: overrides.vantageTtlMs ?? 86_400_000,
    pollIntervalMs: 1000,
    pollTimeoutMs: 30_000,
    now: overrides.now ?? (() => clock),
    sleep: async (ms) => {
      clock += ms;
    },
  });

  return { provider, requester };
}

const TARGET = { host: "203.0.113.10", port: 443, domain: "vpn.example.com" };

function vantage(id: string, region: string): Vantage {
  return { id, region, countryCode: region, network: "datacenter" };
}

function readingFor(
  readings: readonly ProbeReading[],
  id: string,
): ProbeReading {
  const found = readings.find((reading) => reading.vantage.id === id);

  if (!found) throw new Error(`no reading for ${id}`);

  return found;
}

describe("listVantages", () => {
  it("picks the nodes whose country matches the region", async () => {
    const { provider, requester } = providerWith(() => NODES_RESPONSE);

    const vantages = await provider.listVantages(requester);

    expect(vantages.map((v) => `${v.region}:${v.id}`)).toEqual([
      "ru:ru1.node.check-host.net",
      "ru:ru2.node.check-host.net",
      "eu:de1.node.check-host.net",
    ]);
  });

  // check-host has three Russian nodes in total, so a region asking for four
  // gets three. Normal, not an error — and visible, because each reading
  // carries its region.
  it("returns fewer than asked when the service has fewer", async () => {
    const { provider, requester } = providerWith(() => NODES_RESPONSE);

    const vantages = await provider.listVantages(requester);

    expect(REGIONS.ru?.count).toBe(4);
    expect(vantages.filter((v) => v.region === "ru")).toHaveLength(2);
  });

  it("keeps the region key, not the country, on each vantage", async () => {
    const { provider, requester } = providerWith(() => NODES_RESPONSE);

    const vantages = await provider.listVantages(requester);
    const german = vantages.find((v) => v.id.startsWith("de1"));

    expect(german).toMatchObject({ region: "eu", countryCode: "de" });
  });

  it("caches the list instead of refetching on every check", async () => {
    const { provider, requester } = providerWith(() => NODES_RESPONSE);

    await provider.listVantages(requester);
    await provider.listVantages(requester);

    expect(requester.urls).toHaveLength(1);
  });

  it("refetches once the cache is older than the configured lifetime", async () => {
    let clock = 1_000_000;
    const { provider, requester } = providerWith(() => NODES_RESPONSE, {
      vantageTtlMs: 1000,
      now: () => clock,
    });

    await provider.listVantages(requester);
    clock += 1001;
    await provider.listVantages(requester);

    expect(requester.urls).toHaveLength(2);
  });

  // A clock that does not advance with the sleep must not turn the poll loop
  // into an endless one; both are injectable, so the pair can disagree.
  it("bounds the polling by count as well as by the clock", async () => {
    const requester = new ScriptedRequester((url) =>
      url.includes("/check-result/")
        ? { ru1: [{ time: 0.01 }], de1: null }
        : { ok: 1, request_id: "r" },
    );

    const frozen = new CheckHostProvider({
      regions: REGIONS,
      vantageTtlMs: 86_400_000,
      pollIntervalMs: 1000,
      pollTimeoutMs: 10_000,
      now: () => 0,
      sleep: async () => {},
    });

    await frozen.probe({
      target: TARGET,
      vantages: [vantage("ru1", "ru"), vantage("de1", "eu")],
      methods: ["tcp"],
      requester,
    });

    const polls = requester.urls.filter((url) =>
      url.includes("/check-result/"),
    );

    expect(polls).toHaveLength(10);
  });
});

describe("probe", () => {
  const VANTAGES = [vantage("ru1", "ru"), vantage("de1", "eu")];

  /** Start call, then one result call carrying the given payload. */
  function scriptFor(results: Record<string, unknown>) {
    return (url: string) =>
      url.includes("/check-result/") ? results : { ok: 1, request_id: "req-1" };
  }

  it("asks for the right host format per method", async () => {
    const { provider, requester } = providerWith(
      scriptFor({ ru1: [{ time: 0.01 }], de1: [{ time: 0.02 }] }),
    );

    await provider.probe({
      target: TARGET,
      vantages: VANTAGES,
      methods: ["tcp", "http", "ping"],
      requester,
    });

    const starts = requester.urls.filter((url) => url.includes("/check-"));

    expect(starts.some((url) => url.includes("203.0.113.10%3A443"))).toBe(true);
    expect(
      starts.some((url) =>
        url.includes(encodeURIComponent("https://vpn.example.com/")),
      ),
    ).toBe(true);
    expect(starts.some((url) => url.includes("host=203.0.113.10&"))).toBe(true);
  });

  it("names every vantage point in the start call", async () => {
    const { provider, requester } = providerWith(
      scriptFor({ ru1: [{ time: 0.01 }], de1: [{ time: 0.02 }] }),
    );

    await provider.probe({
      target: TARGET,
      vantages: VANTAGES,
      methods: ["tcp"],
      requester,
    });

    const start = requester.urls[0] ?? "";

    expect(start).toContain("node=ru1");
    expect(start).toContain("node=de1");
  });

  it("reads a successful tcp result as reachable with a round-trip time", async () => {
    const { provider, requester } = providerWith(
      scriptFor({ ru1: [{ time: 0.016 }], de1: [{ time: 0.031 }] }),
    );

    const readings = await provider.probe({
      target: TARGET,
      vantages: VANTAGES,
      methods: ["tcp"],
      requester,
    });

    expect(readingFor(readings, "ru1")).toMatchObject({
      ok: true,
      method: "tcp",
      rtt: 0.016,
    });
  });

  it("reads a failed tcp result as unreachable, keeping the reason", async () => {
    const { provider, requester } = providerWith(
      scriptFor({
        ru1: [{ error: "Connection timed out" }],
        de1: [{ time: 0.031 }],
      }),
    );

    const readings = await provider.probe({
      target: TARGET,
      vantages: VANTAGES,
      methods: ["tcp"],
      requester,
    });

    expect(readingFor(readings, "ru1")).toMatchObject({
      ok: false,
      error: "Connection timed out",
    });
    expect(readingFor(readings, "de1").ok).toBe(true);
  });

  // ping returns nested arrays of individual attempts, unlike the others.
  it("counts a majority of successful pings as reachable", async () => {
    const { provider, requester } = providerWith(
      scriptFor({
        ru1: [
          [
            ["OK", 0.04, "1.1.1.1"],
            ["TIMEOUT", 3.0],
            ["OK", 0.05],
          ],
        ],
        de1: [
          [
            ["TIMEOUT", 3.0],
            ["TIMEOUT", 3.0],
          ],
        ],
      }),
    );

    const readings = await provider.probe({
      target: TARGET,
      vantages: VANTAGES,
      methods: ["ping"],
      requester,
    });

    expect(readingFor(readings, "ru1")).toMatchObject({ ok: true });
    expect(readingFor(readings, "de1")).toMatchObject({
      ok: false,
      error: "TIMEOUT",
    });
  });

  // http is a flat array whose first field is a numeric success flag.
  it("reads the numeric flag of an http result", async () => {
    const { provider, requester } = providerWith(
      scriptFor({
        ru1: [[1, 0.13, "OK", "200", "1.1.1.1"]],
        de1: [[0, 0.5, "Connection refused", null, null]],
      }),
    );

    const readings = await provider.probe({
      target: TARGET,
      vantages: VANTAGES,
      methods: ["http"],
      requester,
    });

    expect(readingFor(readings, "ru1")).toMatchObject({ ok: true, rtt: 0.13 });
    expect(readingFor(readings, "de1")).toMatchObject({
      ok: false,
      error: "Connection refused",
    });
  });

  // A vantage that never reported is not the same as one that reported a
  // failure, and the verdict must not count it as evidence either way.
  it("marks a vantage missing from the response as no response", async () => {
    const { provider, requester } = providerWith(
      scriptFor({ ru1: [{ time: 0.01 }], de1: null }),
    );

    const readings = await provider.probe({
      target: TARGET,
      vantages: VANTAGES,
      methods: ["tcp"],
      requester,
    });

    expect(readingFor(readings, "de1")).toMatchObject({
      ok: false,
      error: "no response",
    });
  });

  // The service drops a vantage point it cannot use and says so in the start
  // response. Waiting for a result it will never send would burn the whole
  // deadline on every check.
  it("waits only for the vantage points the service accepted", async () => {
    const { provider, requester } = providerWith((url) =>
      url.includes("/check-result/")
        ? { ru1: [{ time: 0.01 }] }
        : { ok: 1, request_id: "r", nodes: { ru1: [] } },
    );

    await provider.probe({
      target: TARGET,
      vantages: VANTAGES,
      methods: ["tcp"],
      requester,
    });

    const polls = requester.urls.filter((url) =>
      url.includes("/check-result/"),
    );

    expect(polls).toHaveLength(1);
  });

  it("still reports a vantage the service dropped as no response", async () => {
    const { provider, requester } = providerWith((url) =>
      url.includes("/check-result/")
        ? { ru1: [{ time: 0.01 }] }
        : { ok: 1, request_id: "r", nodes: { ru1: [] } },
    );

    const readings = await provider.probe({
      target: TARGET,
      vantages: VANTAGES,
      methods: ["tcp"],
      requester,
    });

    expect(readingFor(readings, "de1")).toMatchObject({
      ok: false,
      error: "no response",
    });
  });

  it("stops polling as soon as every vantage has reported", async () => {
    const { provider, requester } = providerWith((url, call) => {
      if (!url.includes("/check-result/")) return { ok: 1, request_id: "r" };

      // First poll: only one of the two has answered.
      return call === 1
        ? { ru1: [{ time: 0.01 }], de1: null }
        : { ru1: [{ time: 0.01 }], de1: [{ time: 0.02 }] };
    });

    await provider.probe({
      target: TARGET,
      vantages: VANTAGES,
      methods: ["tcp"],
      requester,
    });

    const polls = requester.urls.filter((url) =>
      url.includes("/check-result/"),
    );

    expect(polls).toHaveLength(2);
  });

  // Partial readings still produce a verdict; hanging produces nothing.
  it("returns what arrived when the results never complete", async () => {
    const { provider, requester } = providerWith((url) =>
      url.includes("/check-result/")
        ? { ru1: [{ time: 0.01 }], de1: null }
        : { ok: 1, request_id: "r" },
    );

    const readings = await provider.probe({
      target: TARGET,
      vantages: VANTAGES,
      methods: ["tcp"],
      requester,
    });

    expect(readingFor(readings, "ru1").ok).toBe(true);
    expect(readingFor(readings, "de1")).toMatchObject({ error: "no response" });
  });

  it("fails loudly when the service refuses to start a check", async () => {
    const { provider, requester } = providerWith(() => ({
      error: "too many requests",
    }));

    await expect(
      provider.probe({
        target: TARGET,
        vantages: VANTAGES,
        methods: ["tcp"],
        requester,
      }),
    ).rejects.toThrow("too many requests");
  });

  it("merges the readings of every requested method", async () => {
    const { provider, requester } = providerWith(
      scriptFor({ ru1: [{ time: 0.01 }], de1: [{ time: 0.02 }] }),
    );

    const readings = await provider.probe({
      target: TARGET,
      vantages: VANTAGES,
      methods: ["tcp", "ping"],
      requester,
    });

    expect(readings).toHaveLength(4);
    expect(new Set(readings.map((r) => r.method))).toEqual(
      new Set(["tcp", "ping"]),
    );
  });
});
