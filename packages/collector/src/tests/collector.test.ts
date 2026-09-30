import {
  buildNodeState,
  createLogger,
  type Logger,
  type Probe,
  type ProbeDescriptor,
  parseConfig,
} from "@ephorate/core";
import { afterEach, describe, expect, it } from "vitest";
import { Collector } from "../collector";
import { SSH_TOTAL_LIMIT } from "../execution/ssh-gates";
import { ProbeRegistry } from "../probes/registry";
import { longestRunMs } from "../probes/with-retry";
import { SqliteStorage } from "../storage/sqlite-storage";

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

describe("Collector.queueState", () => {
  it("answers for a registered probe and refuses an unknown one", async () => {
    const collector = await collectorOf();

    expect(collector.queueState("fast")).toEqual({
      active: 0,
      queued: 0,
      limit: 2,
    });
    expect(() => collector.queueState("ghost")).toThrow(/no concurrency limit/);
  });
});

describe("Collector.queues", () => {
  it("lists every registered probe, and the ssh limits at rest", async () => {
    const collector = await collectorOf();

    expect(collector.queues()).toEqual({
      fast: { active: 0, queued: 0, limit: 2 },
    });
    expect(collector.sshQueues()).toEqual({
      processes: { active: 0, queued: 0, limit: SSH_TOTAL_LIMIT },
      logins: {},
    });
  });
});

describe("Collector: acknowledgements after a write", () => {
  /** Read at every run: the test moves the node between statuses. */
  let level = 0;

  const GAUGE: ProbeDescriptor = {
    name: "gauge",
    requiresExecutor: false,
    enabledByDefault: true,
    defaults: { interval: 60, timeout: 10, retries: 0, concurrency: 2 },
  };

  const gaugeProbe: Probe<{ level: number }> = {
    descriptor: GAUGE,
    run: async () => ({ ok: true, data: { level }, durationMs: 1 }),
    toMetrics: (data, context) => [
      {
        ts: context.startedAt,
        node: context.nodeName,
        metric: "gauge.level",
        value: data.level,
      },
    ],
  };

  // Never runs: a disabled probe must not hold the check back forever.
  const idleProbe: Probe<Record<string, never>> = {
    descriptor: { ...FAST, name: "idle", enabledByDefault: false },
    run: async () => ({ ok: true, data: {}, durationMs: 1 }),
    toMetrics: () => [],
  };

  async function gaugedCollector(
    target: SqliteStorage = new SqliteStorage(":memory:"),
    logger: Logger = createLogger({ level: "silent" }),
  ): Promise<Collector> {
    const registry = new ProbeRegistry();
    registry.register(fastProbe);
    registry.register(gaugeProbe);
    registry.register(idleProbe);

    const config = parseConfig(
      {
        nodes: [{ name: "pupa", host: "203.0.113.10" }],
        thresholds: { "gauge.level": { warn: 50, critical: 90 } },
      },
      registry.descriptors(),
    );

    storage = target;
    await storage.migrate();

    return new Collector({ config, registry, storage, logger });
  }

  const nowSeconds = () => Math.floor(Date.now() / 1000);

  // Loud when unset: `storage?.` would make "not acknowledged" pass vacuously.
  function db(): SqliteStorage {
    if (!storage) throw new Error("no storage: build the collector first");
    return storage;
  }

  async function acknowledge(untilOk: boolean): Promise<void> {
    await db().acknowledge({
      node: "pupa",
      since: nowSeconds(),
      status: "warn",
      untilOk,
    });
  }

  async function isAcknowledged(): Promise<boolean> {
    const inForce = await db().acknowledgements(nowSeconds());
    return inForce.some((each) => each.node === "pupa");
  }

  async function statusOf(collector: Collector): Promise<string | undefined> {
    const [state] = buildNodeState({
      nodes: collector.nodes,
      points: await db().latest("pupa"),
      now: nowSeconds(),
    });
    return state?.status;
  }

  it("clears the default kind once the status changes, not before", async () => {
    const collector = await gaugedCollector();
    level = 60;
    await collector.runNow("pupa").finished;
    await acknowledge(false);

    level = 70;
    await collector.runNow("pupa").finished;
    expect(await statusOf(collector)).toBe("warn");
    expect(await isAcknowledged()).toBe(true);

    level = 95;
    await collector.runNow("pupa").finished;
    expect(await statusOf(collector)).toBe("critical");
    expect(await isAcknowledged()).toBe(false);
  });

  it("keeps the sticky kind through a worse status, clears it at ok", async () => {
    const collector = await gaugedCollector();
    level = 60;
    await collector.runNow("pupa").finished;
    await acknowledge(true);

    level = 95;
    await collector.runNow("pupa").finished;
    expect(await statusOf(collector)).toBe("critical");
    expect(await isAcknowledged()).toBe(true);

    level = 10;
    await collector.runNow("pupa").finished;
    expect(await statusOf(collector)).toBe("ok");
    expect(await isAcknowledged()).toBe(false);
  });

  // A restart after downtime: the first probe back sees the others stale.
  it("waits for every enabled probe after the start", async () => {
    const collector = await gaugedCollector();
    const longAgo = nowSeconds() - 3600;
    await db().write([
      { ts: longAgo, node: "pupa", metric: "gauge.level", value: 60 },
      { ts: longAgo, node: "pupa", metric: "gauge.up", ok: true },
      { ts: longAgo, node: "pupa", metric: "fast.up", ok: true },
    ]);
    await acknowledge(false);

    level = 60;
    await collector.runNow("pupa", "gauge").finished;
    expect(await statusOf(collector)).toBe("stale");
    expect(await isAcknowledged()).toBe(true);

    await collector.runNow("pupa", "fast").finished;
    expect(await statusOf(collector)).toBe("warn");
    expect(await isAcknowledged()).toBe(true);

    level = 95;
    await collector.runNow("pupa", "gauge").finished;
    expect(await isAcknowledged()).toBe(false);
  });

  it("logs a failure to settle and keeps the measurement", async () => {
    class BrokenStorage extends SqliteStorage {
      override async acknowledgements(): Promise<never> {
        throw new Error("disk I/O error");
      }
    }
    const lines: string[] = [];
    const collector = await gaugedCollector(
      new BrokenStorage(":memory:"),
      createLogger({
        level: "error",
        format: "json",
        write: (line) => lines.push(line),
      }),
    );

    level = 60;
    await collector.runNow("pupa").finished;

    const points = await db().latest("pupa");
    expect(points.find((point) => point.metric === "gauge.level")?.value).toBe(
      60,
    );
    expect(lines.join("\n")).toMatch(/acknowledgement not settled/);
    expect(lines.join("\n")).toMatch(/disk I\/O error/);
    expect(lines.join("\n")).not.toMatch(/unhandled error/);
  });
});
