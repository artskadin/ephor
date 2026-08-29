import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigError, parseConfig } from "../load.js";
import { buildConfigSchema } from "../schema.js";
import { TEST_PROBES } from "./fixtures/probes.js";

const schema = buildConfigSchema(TEST_PROBES);

function issuesOf(data: unknown): string[] {
  const result = schema.safeParse(data);

  if (result.success) throw new Error("expected the config to be rejected");

  return result.error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );
}

describe("buildConfigSchema", () => {
  it("accepts a config that lists nothing but nodes", () => {
    const config = parseConfig(
      { nodes: [{ name: "solo", host: "203.0.113.10" }] },
      TEST_PROBES,
    );

    expect(config.nodes).toHaveLength(1);
    expect(config.storage.retention).toBe(7_776_000);
    expect(config.storage.pruneAt).toBe("04:00");
    // No path is invented here: a relative one would follow the working
    // directory. The collector picks an absolute one.
    expect(config.storage.path).toBeUndefined();
  });

  it("gives every registered probe a section, mentioned or not", () => {
    const config = parseConfig(
      { nodes: [{ name: "solo", host: "203.0.113.10" }] },
      TEST_PROBES,
    );

    expect(Object.keys(config.probes).sort()).toEqual([
      "reachability",
      "speed",
      "system",
    ]);
    // The probe's own settings defaults are applied even though the user
    // never wrote a `probes.reachability` section.
    expect(config.probes.reachability).toEqual({ quorum: 0.5, regions: {} });
  });

  it.each(["probes", "probeDefaults", "storage"])(
    "treats an emptied %s section the same as a missing one",
    (section) => {
      const blanked = parseConfig(
        { [section]: null, nodes: [{ name: "solo", host: "203.0.113.10" }] },
        TEST_PROBES,
      );

      const omitted = parseConfig(
        { nodes: [{ name: "solo", host: "203.0.113.10" }] },
        TEST_PROBES,
      );

      expect(blanked).toEqual(omitted);
    },
  );

  it("treats emptied sections inside a node the same as missing ones", () => {
    const config = parseConfig(
      {
        nodes: [
          {
            name: "solo",
            host: "203.0.113.10",
            tags: null,
            ports: null,
            probes: null,
          },
        ],
      },
      TEST_PROBES,
    );

    expect(config.nodes[0]).toMatchObject({ tags: [], ports: [], probes: {} });
  });

  it("refuses a probe whose settings collide with the shared keys", () => {
    const [base] = TEST_PROBES;

    if (!base) throw new Error("expected a probe fixture");

    const clashing = [
      {
        ...base,
        name: "speedy",
        settings: { timeout: z.number(), urls: z.array(z.string()) },
      },
    ];

    expect(() => buildConfigSchema(clashing)).toThrow(
      /"speedy" declares settings that collide.*timeout/s,
    );
  });

  it("expands an ssh alias written as a plain string", () => {
    const config = parseConfig(
      { nodes: [{ name: "solo", host: "203.0.113.10", ssh: "my-vpn" }] },
      TEST_PROBES,
    );

    expect(config.nodes[0]?.ssh).toEqual({ alias: "my-vpn", port: 22 });
  });

  it("expands a bare port number into a public tcp port", () => {
    const config = parseConfig(
      { nodes: [{ name: "solo", host: "203.0.113.10", ports: [443] }] },
      TEST_PROBES,
    );

    expect(config.nodes[0]?.ports).toEqual([
      { port: 443, proto: "tcp", expose: "public" },
    ]);
  });

  it("keeps probe-specific settings and applies their defaults", () => {
    const config = parseConfig(
      {
        probes: { reachability: { regions: { ru: { match: ["ru"] } } } },
        nodes: [{ name: "solo", host: "203.0.113.10" }],
      },
      TEST_PROBES,
    );

    expect(config.probes.reachability).toEqual({
      quorum: 0.5,
      regions: { ru: { match: ["ru"] } },
    });
  });

  it("names the probes that do exist when one is misspelled", () => {
    const issues = issuesOf({
      probes: { reachabilty: { interval: 60 } },
      nodes: [{ name: "solo", host: "203.0.113.10" }],
    });

    expect(issues).toEqual([
      'probes.reachabilty: Unknown probe "reachabilty". ' +
        "Available: system, reachability, speed",
    ]);
  });

  it("rejects an unknown probe inside a node too", () => {
    const issues = issuesOf({
      nodes: [{ name: "solo", host: "203.0.113.10", probes: { sistem: {} } }],
    });

    expect(issues[0]).toContain('Unknown probe "sistem"');
  });

  it("rejects a misspelled option inside a probe section", () => {
    const issues = issuesOf({
      probes: { system: { interwal: "15m" } },
      nodes: [{ name: "solo", host: "203.0.113.10" }],
    });

    expect(issues[0]).toContain("probes.system");
  });

  it("refuses concurrency on a node, where it would be meaningless", () => {
    const issues = issuesOf({
      nodes: [
        {
          name: "solo",
          host: "203.0.113.10",
          probes: { system: { concurrency: 4 } },
        },
      ],
    });

    expect(issues[0]).toContain("concurrency");
  });

  it("validates probe-specific values against the probe's own rules", () => {
    const issues = issuesOf({
      probes: { reachability: { quorum: 1.5 } },
      nodes: [{ name: "solo", host: "203.0.113.10" }],
    });

    expect(issues[0]).toContain("probes.reachability.quorum");
  });

  it("explains that interval belongs to a probe, not to the shared section", () => {
    const issues = issuesOf({
      probeDefaults: { interval: "1m" },
      nodes: [{ name: "solo", host: "203.0.113.10" }],
    });

    expect(issues).toEqual([
      "probeDefaults.interval: interval is set per probe, " +
        "e.g. probes.system.interval",
    ]);
  });

  it("rejects a misspelled key in the shared section", () => {
    const issues = issuesOf({
      probeDefaults: { retires: 3 },
      nodes: [{ name: "solo", host: "203.0.113.10" }],
    });

    expect(issues[0]).toContain("retires");
  });

  it("rejects duplicate node names", () => {
    const issues = issuesOf({
      nodes: [
        { name: "twin", host: "203.0.113.10" },
        { name: "twin", host: "203.0.113.11" },
      ],
    });

    expect(issues).toEqual(["nodes: node names must be unique"]);
  });

  it("requires at least one node", () => {
    expect(issuesOf({ nodes: [] })[0]).toContain("at least one node");
  });

  it("reports the path of every invalid field, not just the first", () => {
    const issues = issuesOf({
      nodes: [{ name: "bad name!", host: "203.0.113.10", tags: [""] }],
    });

    expect(issues).toHaveLength(2);
  });

  it("parses durations written with a unit suffix", () => {
    const config = parseConfig(
      {
        probes: { system: { interval: "15m", timeout: "30s" } },
        nodes: [{ name: "solo", host: "203.0.113.10" }],
        storage: { retention: "7d" },
      },
      TEST_PROBES,
    );

    expect(config.probes.system?.interval).toBe(900);
    expect(config.probes.system?.timeout).toBe(30);
    expect(config.storage.retention).toBe(604_800);
  });

  it("throws a ConfigError that points at the offending field", () => {
    expect(() =>
      parseConfig({ nodes: [] }, TEST_PROBES, "/etc/x.yaml"),
    ).toThrow(ConfigError);
  });
});
