import { parseConfig, resolveConfig } from "@ephorate/core";
import { describe, expect, it } from "vitest";
import { describeProbeCoverage } from "../probe-coverage";
import { reachabilityProbeDescriptor } from "../probes/reachability/reachability-probe";
import { systemProbeDescriptor } from "../probes/system/system-probe";

const PROBES = [systemProbeDescriptor, reachabilityProbeDescriptor];
const PROBE_NAMES = PROBES.map((probe) => probe.name);

function coverageOf(config: Record<string, unknown>) {
  return describeProbeCoverage(
    resolveConfig(parseConfig(config, PROBES), PROBES),
    PROBE_NAMES,
  );
}

const node = (name: string, index: number, fields = {}) => ({
  name,
  host: `203.0.113.${10 + index}`,
  ...fields,
});

describe("describeProbeCoverage", () => {
  it("names a probe on every node, and one left out of the file as off", () => {
    expect(
      coverageOf({
        probes: { reachability: {} },
        nodes: ["achilles", "hector"].map((name, index) => node(name, index)),
      }),
    ).toEqual([
      { isWarning: false, text: "probe system: off" },
      { isWarning: false, text: "probe reachability: on every node (2)" },
    ]);
  });

  it("says why not, grouped by reason", () => {
    const [system] = coverageOf({
      probes: { system: {}, reachability: {} },
      nodes: [
        node("achilles", 0, { ssh: "achilles" }),
        node("german", 1),
        node("hector", 2, {
          ssh: "hector",
          probes: { system: { enabled: false } },
        }),
        node("priam", 3),
      ],
    });

    expect(system).toEqual({
      isWarning: false,
      text:
        "probe system: on 1 of 4 nodes; not on german, priam (no `ssh:` in " +
        "the config); hector (off in the config)",
    });
  });

  // A fleet must not print 200 names on one line.
  it("counts the nodes past a few, so the line stays short", () => {
    const nodes = Array.from({ length: 200 }, (_, index) =>
      node(`node-${index}`, index, index < 12 ? {} : { ssh: `node-${index}` }),
    );
    const [system] = coverageOf({
      probes: { system: {}, reachability: {} },
      nodes,
    });

    expect(system?.text).toBe(
      "probe system: on 188 of 200 nodes; not on 12 nodes (no `ssh:` in the config)",
    );
  });

  it("warns of a probe written in the file that runs on no node", () => {
    const [system] = coverageOf({
      probes: { system: {}, reachability: {} },
      nodes: [node("german", 0), node("priam", 1)],
    });

    expect(system).toEqual({
      isWarning: true,
      text: "probe system: on no node (no `ssh:` in the config)",
    });
  });

  it("names the node of a fleet of one", () => {
    const [, reachability] = coverageOf({
      probes: { reachability: {} },
      nodes: [node("achilles", 0)],
    });

    expect(reachability?.text).toBe("probe reachability: on achilles");
  });

  // Not "on every node (0)": nothing is measured, and the log must say so.
  it("says nothing runs when every node is switched off", () => {
    expect(
      coverageOf({
        probes: { reachability: {} },
        nodes: [node("achilles", 0, { enabled: false })],
      }),
    ).toEqual([{ isWarning: true, text: "no node is enabled: nothing runs" }]);
  });
});
