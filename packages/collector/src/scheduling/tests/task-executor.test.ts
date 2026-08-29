import type { ResolvedNode } from "@ephor/core";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "../scheduler.js";
import { TaskExecutor } from "../task-executor.js";

const NODE: ResolvedNode = {
  node: {
    name: "solo",
    host: "203.0.113.10",
    tags: [],
    enabled: true,
    local: false,
    ports: [],
    probes: {},
  },
  probes: new Map(),
};

function taskFor(probe: string): Task {
  return { probe, node: NODE };
}

describe("TaskExecutor", () => {
  it("runs a task and reports it finished", async () => {
    const finished: Task[] = [];
    const handler = vi.fn(async () => {});

    const executor = new TaskExecutor({
      concurrencyByProbe: new Map([["system", 2]]),
      handler,
      onTaskFinished: (task) => finished.push(task),
    });

    executor.submit([taskFor("system")]);
    await vi.waitFor(() => expect(finished).toHaveLength(1));

    expect(handler).toHaveBeenCalledOnce();
  });

  // submit() runs inside the scheduler's interval callback: throwing here
  // would kill the collector, and skipping without reporting would leave the
  // pair marked in flight forever, silencing that node/probe for good.
  it("skips a task for an unregistered probe without throwing", async () => {
    const finished: Task[] = [];
    const handler = vi.fn(async () => {});
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const executor = new TaskExecutor({
      concurrencyByProbe: new Map([["system", 2]]),
      handler,
      onTaskFinished: (task) => finished.push(task),
    });

    expect(() =>
      executor.submit([taskFor("ghost"), taskFor("system")]),
    ).not.toThrow();

    await vi.waitFor(() => expect(finished).toHaveLength(2));

    // The unknown probe never runs, the known one still does.
    expect(handler).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0]?.[0])).toContain("ghost");

    consoleError.mockRestore();
  });

  it("keeps one limiter per probe", async () => {
    const finished: Task[] = [];

    const executor = new TaskExecutor({
      concurrencyByProbe: new Map([
        ["system", 1],
        ["reachability", 1],
      ]),
      handler: async () => {},
      onTaskFinished: (task) => finished.push(task),
    });

    executor.submit([taskFor("system"), taskFor("reachability")]);
    await vi.waitFor(() => expect(finished).toHaveLength(2));

    expect(Object.keys(executor.stats()).sort()).toEqual([
      "reachability",
      "system",
    ]);
  });
});
