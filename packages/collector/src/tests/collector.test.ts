import {
  createLogger,
  type Probe,
  type ProbeDescriptor,
  parseConfig,
} from "@ephor/core";
import { afterEach, describe, expect, it } from "vitest";
import { Collector } from "../collector.js";
import { ProbeRegistry } from "../probes/registry.js";
import { longestRunMs } from "../probes/with-retry.js";
import { SqliteStorage } from "../storage/sqlite-storage.js";

/**
 * The real pipeline — scheduler, executor, retry, storage — around a probe
 * that succeeds at once. Nothing is faked but the measurement, so what these
 * tests cover is the wiring the API's fixtures stand in for.
 */
const FAST: ProbeDescriptor = {
  name: "fast",
  requiresExecutor: false,
  enabledByDefault: true,
  defaults: { interval: 60, timeout: 10, retries: 0, concurrency: 2 },
};

const fastProbe: Probe<Record<string, never>> = {
  descriptor: FAST,
  run: async () => ({ ok: true, data: {}, durationMs: 1 }),
  toMetrics: () => [],
};

let storage: SqliteStorage | undefined;

async function collectorOf(): Promise<Collector> {
  const registry = new ProbeRegistry();
  registry.register(fastProbe);

  const config = parseConfig(
    {
      nodes: [
        { name: "pupa", host: "203.0.113.10" },
        { name: "lupa", host: "203.0.113.11" },
        { name: "mupa", host: "203.0.113.12" },
      ],
    },
    registry.descriptors(),
  );

  storage = new SqliteStorage(":memory:");
  await storage.migrate();

  return new Collector({
    config,
    registry,
    storage,
    logger: createLogger({ level: "silent" }),
  });
}

afterEach(async () => {
  await storage?.close();
  storage = undefined;
});

describe("Collector.runNow", () => {
  it("forces the pairs asked for and settles once they have written", async () => {
    const collector = await collectorOf();

    const run = collector.runNow("pupa");

    expect(run.tasks.map((task) => task.node.node.name)).toEqual(["pupa"]);
    await run.finished;

    const points = await storage?.latest("pupa");

    expect(points?.find((point) => point.metric === "fast.up")?.ok).toBe(true);
    expect(run.unfinished()).toEqual([]);
  });

  // Three pairs through a limit of two: the third waits for a slot, and the
  // budget has to say so.
  it("budgets the run from the queue it has just filled", async () => {
    const collector = await collectorOf();

    const run = collector.runNow();

    expect(run.tasks).toHaveLength(3);
    expect(run.budgetMs).toBe(2 * longestRunMs(10_000, 0));

    await run.finished;
  });
});

describe("Collector.queueOf", () => {
  it("answers for a registered probe and refuses an unknown one", async () => {
    const collector = await collectorOf();

    expect(collector.queueOf("fast")).toEqual({
      active: 0,
      queued: 0,
      limit: 2,
    });
    expect(() => collector.queueOf("ghost")).toThrow(/no concurrency limit/);
  });
});
