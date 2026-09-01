import { createLogger, type Logger, type ResolvedNode } from "@ephor/core";
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
    thresholds: {},
  },
  probes: new Map(),
  thresholds: new Map(),
};

function taskFor(probe: string): Task {
  return { probe, node: NODE };
}

/** Captured as parsed records, so assertions name fields, not substrings. */
function captureLogs(): { logger: Logger; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];

  const logger = createLogger({
    level: "debug",
    format: "json",
    environment: {},
    isTerminal: false,
    write: (line) => records.push(JSON.parse(line) as Record<string, unknown>),
  });

  return { logger, records };
}

describe("TaskExecutor", () => {
  it("runs a task and reports it finished", async () => {
    const finished: Task[] = [];
    const handler = vi.fn(async () => {});

    const executor = new TaskExecutor({
      concurrencyByProbe: new Map([["system", 2]]),
      handler,
      onTaskFinished: (task) => finished.push(task),
      logger: captureLogs().logger,
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
    const { logger, records } = captureLogs();

    const executor = new TaskExecutor({
      concurrencyByProbe: new Map([["system", 2]]),
      handler,
      onTaskFinished: (task) => finished.push(task),
      logger,
    });

    expect(() =>
      executor.submit([taskFor("ghost"), taskFor("system")]),
    ).not.toThrow();

    await vi.waitFor(() => expect(finished).toHaveLength(2));

    // The unknown probe never runs, the known one still does.
    expect(handler).toHaveBeenCalledOnce();

    const errors = records.filter((record) => record.level === "error");

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ probe: "ghost", node: "solo" });
  });

  it("reports a probe that rejects without losing the task", async () => {
    const finished: Task[] = [];
    const { logger, records } = captureLogs();

    const executor = new TaskExecutor({
      concurrencyByProbe: new Map([["system", 1]]),
      handler: async () => {
        throw new Error("storage is gone");
      },
      onTaskFinished: (task) => finished.push(task),
      logger,
    });

    executor.submit([taskFor("system")]);
    await vi.waitFor(() => expect(finished).toHaveLength(1));

    const [error] = records.filter((record) => record.level === "error");

    expect(error).toMatchObject({
      msg: "unhandled error while running a probe",
      probe: "system",
      cause: { name: "Error", message: "storage is gone" },
    });
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
      logger: captureLogs().logger,
    });

    executor.submit([taskFor("system"), taskFor("reachability")]);
    await vi.waitFor(() => expect(finished).toHaveLength(2));

    expect(Object.keys(executor.stats()).sort()).toEqual([
      "reachability",
      "system",
    ]);
  });
});
