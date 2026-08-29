import { type ProbeDescriptor, parseConfig, resolveConfig } from "@ephor/core";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../clock.js";
import { Scheduler, type Task } from "../scheduler.js";

const PROBES: ProbeDescriptor[] = [
  {
    name: "fast",
    requiresExecutor: false,
    enabledByDefault: true,
    defaults: { interval: 60, timeout: 10, retries: 0, concurrency: 4 },
  },
  {
    name: "slow",
    requiresExecutor: false,
    enabledByDefault: true,
    defaults: { interval: 300, timeout: 10, retries: 0, concurrency: 4 },
  },
];

function makeNodes() {
  const config = parseConfig(
    { nodes: [{ name: "pupa", host: "1.2.3.4" }] },
    PROBES,
  );

  return resolveConfig(config, PROBES);
}

describe("Scheduler", () => {
  let clock: FakeClock;
  let seen: Task[][];
  let scheduler: Scheduler;

  beforeEach(() => {
    clock = new FakeClock(1_000_000);
    seen = [];
    scheduler = new Scheduler({
      clock,
      onTasksDue: (tasks) => seen.push(tasks),
    });
    scheduler.setNodes(makeNodes());
  });

  /** Marks every dispatched task as finished so the next tick may re-run it. */
  function completeAll(): void {
    for (const batch of seen) {
      for (const task of batch) scheduler.complete(task);
    }
  }

  it("runs everything on first tick", () => {
    scheduler.tick();
    expect(seen[0]?.map((t) => t.probe).sort()).toEqual(["fast", "slow"]);
  });

  it("respects per-probe intervals", () => {
    scheduler.tick();
    completeAll();
    seen = [];

    clock.advance(60_000);
    scheduler.tick();

    expect(seen[0]?.map((t) => t.probe)).toEqual(["fast"]);
  });

  it("does not re-run a task that is still in flight", () => {
    scheduler.tick();
    seen = [];

    clock.advance(600_000);
    scheduler.tick();

    expect(seen).toHaveLength(0);
  });

  it("runNow ignores intervals", () => {
    scheduler.tick();
    completeAll();
    seen = [];

    scheduler.runNow();

    expect(seen[0]).toHaveLength(2);
  });
});
