import { describe, expect, it } from "vitest";
import { parseConfig } from "../load.js";
import { resolveConcurrency, resolveConfig, resolveNode } from "../resolve.js";
import type { Config } from "../schema.js";
import { TEST_PROBES } from "./fixtures/probes.js";

function configOf(data: Record<string, unknown>): Config {
  return parseConfig(data, TEST_PROBES);
}

function firstNodeProbes(data: Record<string, unknown>) {
  const config = configOf(data);
  const [resolved] = resolveConfig(config, TEST_PROBES);

  if (!resolved) throw new Error("expected at least one resolved node");

  return resolved.probes;
}

describe("resolveNode", () => {
  it("falls back to the probe's own defaults when nothing overrides them", () => {
    const probes = firstNodeProbes({
      nodes: [{ name: "solo", host: "203.0.113.10", ssh: "solo" }],
    });

    expect(probes.get("system")).toEqual({
      name: "system",
      enabled: true,
      interval: 61,
      timeout: 11,
      retries: 2,
      settings: {},
    });
  });

  it("prefers the global section over the probe default", () => {
    const probes = firstNodeProbes({
      probes: { system: { interval: 600 } },
      nodes: [{ name: "solo", host: "203.0.113.10", ssh: "solo" }],
    });

    expect(probes.get("system")?.interval).toBe(600);
    // Untouched keys still come from the probe.
    expect(probes.get("system")?.timeout).toBe(11);
  });

  it("prefers the shared section over the probe default", () => {
    const probes = firstNodeProbes({
      probeDefaults: { timeout: 7, retries: 4 },
      nodes: [{ name: "solo", host: "203.0.113.10", ssh: "solo" }],
    });

    expect(probes.get("system")?.timeout).toBe(7);
    expect(probes.get("reachability")?.timeout).toBe(7);
    expect(probes.get("system")?.retries).toBe(4);
    // Intervals stay per probe and are untouched by the shared section.
    expect(probes.get("system")?.interval).toBe(61);
    expect(probes.get("reachability")?.interval).toBe(301);
  });

  it("prefers a probe's own section over the shared one", () => {
    const probes = firstNodeProbes({
      probeDefaults: { timeout: 7, retries: 4 },
      probes: { system: { timeout: 9 } },
      nodes: [{ name: "solo", host: "203.0.113.10", ssh: "solo" }],
    });

    expect(probes.get("system")?.timeout).toBe(9);
    expect(probes.get("reachability")?.timeout).toBe(7);
    expect(probes.get("system")?.retries).toBe(4);
  });

  it("applies all four layers in order, narrowest first", () => {
    const probes = firstNodeProbes({
      probeDefaults: { retries: 4 },
      probes: { system: { retries: 5, timeout: 9 } },
      nodes: [
        {
          name: "solo",
          host: "203.0.113.10",
          ssh: "solo",
          probes: { system: { retries: 6 } },
        },
      ],
    });

    expect(probes.get("system")).toMatchObject({
      retries: 6, // node
      timeout: 9, // probe section
      interval: 61, // probe's own default
    });
    expect(probes.get("speed")?.retries).toBe(4); // shared section
  });

  it("lets the shared section switch every probe off", () => {
    const probes = firstNodeProbes({
      probeDefaults: { enabled: false },
      nodes: [{ name: "solo", host: "203.0.113.10", ssh: "solo" }],
    });

    expect(probes.get("system")?.enabled).toBe(false);
    expect(probes.get("reachability")?.enabled).toBe(false);
  });

  it("prefers the node over the global section", () => {
    const probes = firstNodeProbes({
      probes: { system: { interval: 600, retries: 5 } },
      nodes: [
        {
          name: "solo",
          host: "203.0.113.10",
          ssh: "solo",
          probes: { system: { interval: 30 } },
        },
      ],
    });

    expect(probes.get("system")?.interval).toBe(30);
    expect(probes.get("system")?.retries).toBe(5);
  });

  it("leaves a probe off when it ships disabled", () => {
    const probes = firstNodeProbes({
      nodes: [{ name: "solo", host: "203.0.113.10", ssh: "solo" }],
    });

    expect(probes.get("speed")).toMatchObject({
      enabled: false,
      disabledReason: "config",
    });
  });

  it("lets a single node switch on a probe that ships disabled", () => {
    const probes = firstNodeProbes({
      nodes: [
        {
          name: "solo",
          host: "203.0.113.10",
          ssh: "solo",
          probes: { speed: { enabled: true } },
        },
      ],
    });

    expect(probes.get("speed")?.enabled).toBe(true);
  });

  it("distinguishes 'switched off' from 'cannot run here'", () => {
    const probes = firstNodeProbes({
      probes: { reachability: { enabled: false } },
      // No ssh and not local: the system probe has no way in.
      nodes: [{ name: "solo", host: "203.0.113.10" }],
    });

    expect(probes.get("system")).toMatchObject({
      enabled: false,
      disabledReason: "no-executor",
    });
    expect(probes.get("reachability")).toMatchObject({
      enabled: false,
      disabledReason: "config",
    });
  });

  it("treats a local node as having an executor", () => {
    const probes = firstNodeProbes({
      nodes: [{ name: "here", host: "127.0.0.1", local: true }],
    });

    expect(probes.get("system")?.enabled).toBe(true);
  });

  it("hands the probe its own settings without the shared keys", () => {
    const probes = firstNodeProbes({
      probes: {
        reachability: {
          interval: 120,
          concurrency: 9,
          quorum: 0.75,
          regions: { ru: { match: ["ru"] } },
        },
      },
      nodes: [{ name: "solo", host: "203.0.113.10" }],
    });

    expect(probes.get("reachability")?.settings).toEqual({
      quorum: 0.75,
      regions: { ru: { match: ["ru"] } },
    });
  });

  // Nodes may arrive at runtime from a NodeSource rather than the file, and
  // must still inherit the global settings.
  it("resolves a node that did not come from the config file", () => {
    const config = configOf({
      probes: { system: { interval: 42 } },
      nodes: [{ name: "solo", host: "203.0.113.10" }],
    });

    const [discovered] = configOf({
      nodes: [{ name: "added", host: "203.0.113.99", ssh: "added" }],
    }).nodes;

    if (!discovered) throw new Error("expected a node to parse");

    const resolved = resolveNode(config, discovered, TEST_PROBES);

    expect(resolved.probes.get("system")?.interval).toBe(42);
  });
});

describe("resolveConfig", () => {
  it("drops nodes that are switched off", () => {
    const config = configOf({
      nodes: [
        { name: "pupa", host: "203.0.113.10" },
        { name: "lupa", host: "203.0.113.11", enabled: false },
      ],
    });

    const resolved = resolveConfig(config, TEST_PROBES);

    expect(resolved.map((node) => node.node.name)).toEqual(["pupa"]);
  });
});

describe("resolveConcurrency", () => {
  it("uses each probe's own default", () => {
    const config = configOf({ nodes: [{ name: "s", host: "203.0.113.10" }] });

    expect(resolveConcurrency(config, TEST_PROBES)).toEqual(
      new Map([
        ["system", 51],
        ["reachability", 17],
        ["speed", 3],
      ]),
    );
  });

  it("lets the config override one probe without touching the rest", () => {
    const config = configOf({
      probes: { system: { concurrency: 4 } },
      nodes: [{ name: "s", host: "203.0.113.10" }],
    });

    const limits = resolveConcurrency(config, TEST_PROBES);

    expect(limits.get("system")).toBe(4);
    expect(limits.get("reachability")).toBe(17);
  });
});
