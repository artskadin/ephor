import { describe, test, it, expect } from "vitest";
import { ConfigSchema } from "../schema.js";
import { resolveConfig } from "../resolve.js";

const PROBES = [
  { name: "reachability", requiresExecutor: false },
  { name: "system", requiresExecutor: true },
  { name: "speed", requiresExecutor: true },
] as const;

describe("resolveConfig", () => {
  it("applies defaults when node has no overrides", () => {
    const config = ConfigSchema.parse({
      nodes: [{ name: "pupa", host: "1.2.3.4", ssh: { user: "root" } }],
    });

    const [resolved] = resolveConfig(config, PROBES);

    expect(resolved?.checks.get("system")).toEqual({
      enabled: true,
      interval: 300,
      timeout: 10,
      retries: 2,
    });
  });

  it("node override with over defaults", () => {
    const config = ConfigSchema.parse({
      defaults: { interval: "10m" },
      nodes: [
        {
          name: "lupa",
          host: "1.2.3.4",
          checks: { speed: { interval: "1h" } },
        },
      ],
    });

    const [resolved] = resolveConfig(config, PROBES);

    expect(resolved?.checks.get("speed")?.interval).toBe(3600);
    expect(resolved?.checks.get("system")?.interval).toBe(600);
  });

  it("keeps retries: 0 instead of falling back to default", () => {
    const config = ConfigSchema.parse({
      nodes: [
        { name: "pupa", host: "1.2.3.4", checks: { system: { retries: 0 } } },
      ],
    });

    const [resolved] = resolveConfig(config, PROBES);

    expect(resolved?.checks.get("system")?.retries).toBe(0);
  });

  it("disables executor-dependent probes when the node has no access", () => {
    const config = ConfigSchema.parse({
      nodes: [{ name: "remote", host: "1.2.3.4" }], // no ssh, no local
    });

    const [resolved] = resolveConfig(config, PROBES);

    expect(resolved?.checks.get("system")?.enabled).toBe(false);
    expect(resolved?.checks.get("reachability")?.enabled).toBe(true);
  });

  it("enables executor-dependent probes for a local node", () => {
    const config = ConfigSchema.parse({
      nodes: [{ name: "self", host: "127.0.0.1", local: true }],
    });

    const [resolved] = resolveConfig(config, PROBES);

    expect(resolved?.checks.get("system")?.enabled).toBe(true);
  });

  it("skips disabled nodes", () => {
    const config = ConfigSchema.parse({
      nodes: [
        {
          name: "pupa",
          host: "1.2.3.4",
        },
        { name: "lupa", host: "5.6.7.8", enabled: false },
      ],
    });

    expect(resolveConfig(config, PROBES)).toHaveLength(1);
    expect(resolveConfig(config, PROBES)[0]?.node.name).toBe("pupa");
  });
});
