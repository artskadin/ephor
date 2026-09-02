import {
  type MetricPoint,
  parseConfig,
  type QueryFilter,
  resolveConfig,
  type Storage,
} from "@ephor/core";
import { describe, expect, it } from "vitest";
import { reachabilityProbeDescriptor } from "../../probes/reachability/reachability-probe.js";
import { systemProbeDescriptor } from "../../probes/system/system-probe.js";
import { type ApiDeps, getHealth, getState } from "../handlers.js";

/**
 * The real descriptors rather than stand-ins: their intervals are what
 * staleness is judged against, and a fixture drifting from the shipped
 * numbers would make these tests agree with nothing that runs.
 */
const TEST_PROBES = [systemProbeDescriptor, reachabilityProbeDescriptor];

const NOW = 1_800_000_000;

/** Answers `latest()` and nothing else; the handlers ask for nothing else. */
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

function depsOf(
  points: readonly MetricPoint[],
  overrides: Partial<ApiDeps> = {},
): ApiDeps {
  const config = parseConfig(
    {
      nodes: [
        { name: "achilles", host: "203.0.113.10", ssh: "achilles" },
        { name: "retired", host: "203.0.113.11", enabled: false },
      ],
    },
    TEST_PROBES,
  );

  return {
    storage: storageOf(points),
    nodes: resolveConfig(config, TEST_PROBES),
    probeNames: TEST_PROBES.map((probe) => probe.name),
    now: () => NOW,
    startedAt: NOW - 3600,
    runningTasks: () => 2,
    ...overrides,
  };
}

describe("getState", () => {
  it("reports the collector's own clock", async () => {
    const state = await getState(depsOf([]));

    expect(state.now).toBe(NOW);
  });

  it("summarises every watched node", async () => {
    const state = await getState(
      depsOf([
        { ts: NOW, node: "achilles", metric: "system.up", ok: true },
        {
          ts: NOW,
          node: "achilles",
          metric: "system.disk_percent",
          value: 12.5,
        },
      ]),
    );

    expect(state.nodes.map((node) => node.node)).toEqual(["achilles"]);
    expect(
      state.nodes[0]?.metrics.find(
        (view) => view.metric === "system.disk_percent",
      )?.value,
    ).toBe(12.5);
  });

  // The node was switched off on purpose; reporting it would be a false
  // alarm, and the API is where the client's list comes from.
  it("leaves a disabled node out", async () => {
    const state = await getState(
      depsOf([{ ts: NOW, node: "retired", metric: "system.up", ok: true }]),
    );

    expect(state.nodes.map((node) => node.node)).not.toContain("retired");
  });

  it("ages values against the clock it was given, not the wall clock", async () => {
    const state = await getState(
      depsOf([
        { ts: NOW - 45, node: "achilles", metric: "system.up", ok: true },
      ]),
    );

    expect(
      state.nodes[0]?.metrics.find((view) => view.metric === "system.up")
        ?.ageSeconds,
    ).toBe(45);
  });
});

describe("getHealth", () => {
  it("reports uptime, work in flight and what is watched", () => {
    expect(getHealth(depsOf([]))).toEqual({
      ok: true,
      uptimeSeconds: 3600,
      runningTasks: 2,
      nodes: 1,
      probes: ["system", "reachability"],
    });
  });

  // ntp correcting a fresh VPS steps the clock backwards; a negative uptime
  // would be printed as a nonsense duration by every client.
  it("never reports a negative uptime", () => {
    const health = getHealth(depsOf([], { startedAt: NOW + 500 }));

    expect(health.uptimeSeconds).toBe(0);
  });
});
