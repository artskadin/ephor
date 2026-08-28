import { ConfigSchema, resolveConfig } from "@ephor/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../clock.js";
import { Scheduler, type Task } from "../scheduler.js";

const PROBES = [
  { name: "fast", requiresExecutor: false },
  { name: "slow", requiresExecutor: false },
] as const;

function makeNodes() {
  const config = ConfigSchema.parse({
    defaults: { interval: 60 },
    nodes: [
      { name: "pupa", host: "1.2.3.4", checks: { slow: { interval: 300 } } },
    ],
  });

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

  it("runs everything on first tick", () => {
    scheduler.tick();
    expect(seen[0]?.map((t) => t.probe).sort()).toEqual(["fast", "slow"]);
  });

  it("respects per-probe intervals", () => {
    scheduler.tick();
    seen.forEach((batch) => batch.forEach((t) => scheduler.complete(t)));
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
    seen.forEach((batch) => batch.forEach((t) => scheduler.complete(t)));
    seen = [];

    scheduler.runNow();

    expect(seen[0]).toHaveLength(2);
  });
});
