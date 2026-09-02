import { parseConfig, type ResolvedNode, resolveConfig } from "@ephor/core";
import { describe, expect, it } from "vitest";
import { reachabilityProbeDescriptor } from "../../probes/reachability/reachability-probe.js";
import { systemProbeDescriptor } from "../../probes/system/system-probe.js";
import { longestRunMs } from "../../probes/with-retry.js";
import type { ForcedRun, Task } from "../scheduler.js";
import type { QueueState } from "../task-executor.js";
import { waitBudgetMs } from "../wait-budget.js";

/** The shipped descriptors: the budget is judged against real settings. */
const PROBES = [systemProbeDescriptor, reachabilityProbeDescriptor];

const nodes = resolveConfig(
  parseConfig(
    {
      nodes: [
        { name: "achilles", host: "203.0.113.10", ssh: "achilles" },
        { name: "antilochus", host: "203.0.113.11", ssh: "antilochus" },
        { name: "patroclus", host: "203.0.113.12", ssh: "patroclus" },
      ],
    },
    PROBES,
  ),
  PROBES,
);

function nodeNamed(name: string): ResolvedNode {
  const node = nodes.find((candidate) => candidate.node.name === name);
  if (!node) throw new Error(`no node ${name}`);

  return node;
}

const taskOf = (probe: string, node = "achilles"): Task => ({
  node: nodeNamed(node),
  probe,
});

const runOf = (tasks: Task[], deferredProbes: string[] = []): ForcedRun => ({
  tasks,
  deferredProbes: new Set(deferredProbes),
  finished: Promise.resolve(),
  unfinished: () => [],
});

const queueOf = (queue: Partial<QueueState>) => (): QueueState => ({
  active: 1,
  queued: 0,
  limit: 50,
  ...queue,
});

/** The longest one run of that probe can take, from its resolved settings. */
function longest(probe: string): number {
  const settings = nodeNamed("achilles").probes.get(probe);
  if (!settings) throw new Error(`expected ${probe} to be resolved`);

  return longestRunMs(settings.timeout * 1000, settings.retries);
}

describe("waitBudgetMs", () => {
  it("covers the slowest run the settings allow, not one timeout", () => {
    const system = nodeNamed("achilles").probes.get("system");
    if (!system) throw new Error("expected system to be resolved");

    expect(waitBudgetMs(runOf([taskOf("system")]), queueOf({}))).toBe(
      longest("system"),
    );
    // The pauses between attempts count: giving up at exactly
    // timeout × attempts is giving up seconds before the last attempt lands.
    expect(longest("system")).toBeGreaterThan(
      system.timeout * 1000 * (1 + system.retries),
    );
  });

  it("multiplies by the waves a full queue needs", () => {
    expect(
      waitBudgetMs(
        runOf([taskOf("system")]),
        queueOf({ active: 2, queued: 2, limit: 2 }),
      ),
    ).toBe(2 * longest("system"));
  });

  it("adds a wave for a probe with a pair that was mid-run when forced", () => {
    expect(
      waitBudgetMs(runOf([taskOf("system")], ["system"]), queueOf({})),
    ).toBe(2 * longest("system"));
  });

  // The probes run side by side under separate limits; adding them up
  // would wait for a sequence that never happens.
  it("takes the slowest probe rather than the sum", () => {
    expect(
      waitBudgetMs(
        runOf([taskOf("system"), taskOf("reachability")]),
        queueOf({}),
      ),
    ).toBe(Math.max(longest("system"), longest("reachability")));
  });

  // The forced pairs are in line whatever the queue says: a reading that
  // misses them must not shrink the budget to one wave.
  it("counts the forced pairs even when the queue reads empty", () => {
    const threeNodes = [
      taskOf("system", "achilles"),
      taskOf("system", "antilochus"),
      taskOf("system", "patroclus"),
    ];

    expect(
      waitBudgetMs(
        runOf(threeNodes),
        queueOf({ active: 0, queued: 0, limit: 2 }),
      ),
    ).toBe(2 * longest("system"));
  });

  it("is nothing for a run that forced nothing", () => {
    expect(waitBudgetMs(runOf([]), queueOf({}))).toBe(0);
  });
});
