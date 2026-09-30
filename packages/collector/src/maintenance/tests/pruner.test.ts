import {
  type Acknowledgement,
  createLogger,
  type Logger,
  type MetricPoint,
  type QueryFilter,
  type Storage,
} from "@ephorate/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../scheduling/clock";
import { SqliteStorage } from "../../storage/sqlite-storage";
import { Pruner } from "../pruner";

const SILENT = createLogger({ level: "silent" });

function loggerInto(lines: string[]): Logger {
  return createLogger({
    level: "info",
    format: "json",
    write: (line) => lines.push(line),
  });
}

/** Records what prune() was called with, fails once on demand. */
class FakeStorage implements Storage {
  readonly pruneCalls: number[] = [];
  removedPerCall = 5;
  failNext = false;

  async migrate(): Promise<void> {}
  async write(): Promise<void> {}
  async query(_filter: QueryFilter): Promise<MetricPoint[]> {
    return [];
  }
  async latest(): Promise<MetricPoint[]> {
    return [];
  }
  async close(): Promise<void> {}
  async acknowledge(): Promise<void> {}
  async unacknowledge(): Promise<boolean> {
    return false;
  }
  async acknowledgements(): Promise<Acknowledgement[]> {
    return [];
  }
  async expireAcknowledgements(): Promise<number> {
    return 0;
  }

  async prune(olderThanTs: number): Promise<number> {
    this.pruneCalls.push(olderThanTs);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("database is locked");
    }
    return this.removedPerCall;
  }
}

/** Local time, because Pruner compares against getHours/getMinutes. */
function localTime(iso: string): number {
  return new Date(iso).getTime();
}

describe("Pruner", () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = new FakeStorage();
  });

  it("does nothing outside the configured time", async () => {
    const clock = new FakeClock(localTime("2026-01-01T03:59:00"));
    const pruner = new Pruner({
      storage,
      clock,
      retentionSeconds: 86_400,
      runAt: "04:00",
      nodeNames: [],
      logger: SILENT,
    });

    await pruner.tick();

    expect(storage.pruneCalls).toHaveLength(0);
  });

  it("prunes when the clock reaches the configured time", async () => {
    const clock = new FakeClock(localTime("2026-01-01T04:00:00"));
    const pruner = new Pruner({
      storage,
      clock,
      retentionSeconds: 86_400,
      runAt: "04:00",
      nodeNames: [],
      logger: SILENT,
    });

    await pruner.tick();

    expect(storage.pruneCalls).toHaveLength(1);
  });

  it("runs only once even if ticked repeatedly within the same minute", async () => {
    const clock = new FakeClock(localTime("2026-01-01T04:00:00"));
    const pruner = new Pruner({
      storage,
      clock,
      retentionSeconds: 86_400,
      runAt: "04:00",
      nodeNames: [],
      logger: SILENT,
    });

    await pruner.tick();
    await pruner.tick();
    await pruner.tick();

    expect(storage.pruneCalls).toHaveLength(1);
  });

  it("runs again the next day", async () => {
    const clock = new FakeClock(localTime("2026-01-01T04:00:00"));
    const pruner = new Pruner({
      storage,
      clock,
      retentionSeconds: 86_400,
      runAt: "04:00",
      nodeNames: [],
      logger: SILENT,
    });

    await pruner.tick();
    clock.advance(24 * 60 * 60 * 1000);
    await pruner.tick();

    expect(storage.pruneCalls).toHaveLength(2);
  });

  it("computes the cutoff from retention", async () => {
    const now = localTime("2026-01-01T04:00:00");
    const clock = new FakeClock(now);
    const pruner = new Pruner({
      storage,
      clock,
      retentionSeconds: 7 * 86_400,
      runAt: "04:00",
      nodeNames: [],
      logger: SILENT,
    });

    await pruner.runOnce();

    const expectedCutoff = Math.floor(now / 1000) - 7 * 86_400;
    expect(storage.pruneCalls[0]).toBe(expectedCutoff);
  });

  it("logs what it removed", async () => {
    const lines: string[] = [];
    const pruner = new Pruner({
      storage,
      clock: new FakeClock(localTime("2026-01-01T04:00:00")),
      retentionSeconds: 86_400,
      runAt: "04:00",
      nodeNames: [],
      logger: loggerInto(lines),
    });

    await pruner.runOnce();

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        msg: "pruned",
        metrics: 5,
        acknowledgementsExpired: 0,
        acknowledgementsOrphaned: 0,
      }),
    ]);
  });

  it("survives a failing storage, and tries again the next day", async () => {
    storage.failNext = true;
    const lines: string[] = [];
    const clock = new FakeClock(localTime("2026-01-01T04:00:00"));
    const pruner = new Pruner({
      storage,
      clock,
      retentionSeconds: 86_400,
      runAt: "04:00",
      nodeNames: [],
      logger: loggerInto(lines),
    });

    await expect(pruner.tick()).resolves.toBeUndefined();
    expect(lines.join("\n")).toMatch(/pruning failed.*database is locked/);

    clock.advance(24 * 60 * 60 * 1000);
    await pruner.tick();

    expect(storage.pruneCalls).toHaveLength(2);
    expect(lines.join("\n")).toMatch(/"msg":"pruned"/);
  });
});

describe("Pruner on SQLite: acknowledgements", () => {
  let database: SqliteStorage | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it("drops the expired and those of nodes not configured", async () => {
    database = new SqliteStorage(":memory:");
    await database.migrate();

    const now = localTime("2026-01-01T04:00:00");
    const nowSeconds = Math.floor(now / 1000);
    const acknowledged = (node: string, until?: number): Acknowledgement => ({
      node,
      since: nowSeconds - 86_400,
      status: "warn",
      untilOk: false,
      ...(until === undefined ? {} : { until }),
    });
    await database.acknowledge(acknowledged("pupa"));
    await database.acknowledge(acknowledged("rupa", nowSeconds + 60));
    await database.acknowledge(acknowledged("lupa", nowSeconds - 60));
    await database.acknowledge(acknowledged("ghost"));
    await database.acknowledge(acknowledged("gone", nowSeconds - 60));

    const pruner = new Pruner({
      storage: database,
      clock: new FakeClock(now),
      retentionSeconds: 86_400,
      runAt: "04:00",
      nodeNames: ["pupa", "lupa", "rupa"],
      logger: SILENT,
    });

    expect(await pruner.runOnce()).toEqual({
      metrics: 0,
      acknowledgementsExpired: 2,
      acknowledgementsOrphaned: 1,
    });

    // Asked for at the epoch, every row left counts, expired or not.
    const left = await database.acknowledgements(0);
    expect(left.map((each) => each.node)).toEqual(["pupa", "rupa"]);
  });
});
