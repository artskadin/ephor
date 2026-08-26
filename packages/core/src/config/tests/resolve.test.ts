import { describe, test, it, expect } from "vitest";
import { ConfigSchema } from "../schema.js";
import { resolveConfig } from "../resolve.js";

const PROBES = ["reachability", "system", "speed"] as const;

describe("resolveConfig", () => {
  it("applies defaults when node has no overrides", () => {
    const config = ConfigSchema.parse({
      nodes: [{ name: "pupa", host: "1.2.3.4" }],
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
