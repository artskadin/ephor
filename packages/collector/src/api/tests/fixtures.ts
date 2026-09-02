import {
  type MetricPoint,
  parseConfig,
  type QueryFilter,
  resolveConfig,
  type Storage,
} from "@ephor/core";
import { reachabilityProbeDescriptor } from "../../probes/reachability/reachability-probe.js";
import { systemProbeDescriptor } from "../../probes/system/system-probe.js";
import type { ApiDeps } from "../handlers.js";

/**
 * Shared by the handler and server suites, so the two test the same world.
 *
 * The real descriptors rather than stand-ins: their intervals are what
 * staleness is judged against, and a fixture drifting from the shipped
 * numbers would make these tests agree with nothing that runs.
 */
export const TEST_PROBES = [systemProbeDescriptor, reachabilityProbeDescriptor];

export const NOW = 1_800_000_000;

/**
 * Answers `latest()` from a fixed list and records what it was asked. The
 * `latestCalls` log is how a test proves the single-node route asks for one
 * node rather than the fleet — a fake that ignores its argument would hide
 * that regression.
 */
export function storageOf(points: readonly MetricPoint[]): Storage & {
  latestCalls: (string | undefined)[];
} {
  const latestCalls: (string | undefined)[] = [];

  return {
    latestCalls,
    migrate: async () => {},
    write: async () => {},
    query: async (_filter: QueryFilter) => [],
    latest: async (node?: string) => {
      latestCalls.push(node);
      return points.filter(
        (point) => node === undefined || point.node === node,
      );
    },
    prune: async () => 0,
    close: async () => {},
  };
}

/**
 * Two configured nodes: one watched, one switched off. The disabled one is
 * there so every suite can prove it stays out of the API's answers.
 */
export function depsOf(
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
