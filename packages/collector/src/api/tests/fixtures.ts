import {
  type MetricPoint,
  parseConfig,
  type QueryFilter,
  type ResolvedNode,
  resolveConfig,
  type Storage,
} from "@ephor/core";
import { reachabilityProbeDescriptor } from "../../probes/reachability/reachability-probe.js";
import { systemProbeDescriptor } from "../../probes/system/system-probe.js";
import { FakeClock } from "../../scheduling/clock.js";
import { Scheduler, type Task } from "../../scheduling/scheduler.js";
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
 *
 * The list is read on every call, not copied: a check test pushes the points
 * a forced run "wrote" and expects the next `latest()` to see them.
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

/** What the fixture's `forceRun` says a run may take; a test that cares sets its own. */
export const BUDGET_MS = 60_000;

/**
 * The real scheduler over the given nodes, so a fake `forceRun` selects
 * exactly the pairs the daemon would — the selection is the scheduler's,
 * and a fixture re-implementing it would test its own copy. Dispatched
 * tasks land in `dispatched`; a test finishes one with
 * `scheduler.complete(task)`, as the executor would, unless asked to have
 * every task finish the moment it is dispatched.
 */
export function schedulerOf(
  nodes: readonly ResolvedNode[],
  options: { completeAtOnce?: boolean } = {},
): { scheduler: Scheduler; dispatched: Task[] } {
  const dispatched: Task[] = [];
  const scheduler = new Scheduler({
    clock: new FakeClock(NOW * 1000),
    onTasksDue: (tasks) => {
      dispatched.push(...tasks);
      if (options.completeAtOnce) {
        for (const task of tasks) scheduler.complete(task);
      }
    },
  });

  scheduler.setNodes([...nodes]);

  return { scheduler, dispatched };
}

/**
 * Two configured nodes: one watched, one switched off. The disabled one is
 * there so every suite can prove it stays out of the API's answers.
 *
 * A forced run finishes the moment it is dispatched, and the cap never runs
 * out: the default check is the one that goes well. A test about a check
 * that does not overrides `forceRun` and `sleep` together.
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
  const nodes = resolveConfig(config, TEST_PROBES);
  const { scheduler } = schedulerOf(nodes, { completeAtOnce: true });

  return {
    storage: storageOf(points),
    nodes,
    probeNames: TEST_PROBES.map((probe) => probe.name),
    now: () => NOW,
    sleep: () => new Promise(() => {}),
    startedAt: NOW - 3600,
    runningTasks: () => 2,
    forceRun: (node, probe) => ({
      ...scheduler.runNow(node, probe),
      budgetMs: BUDGET_MS,
    }),
    ...overrides,
  };
}
