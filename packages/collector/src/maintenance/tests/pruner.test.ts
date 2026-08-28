import type { MetricPoint, QueryFilter, Storage } from "@ephor/core";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../scheduling/clock.js";
import { Pruner } from "../pruner.js";

/** Records what prune() was called with, ignores everything else. */
class FakeStorage implements Storage {
  readonly pruneCalls: number[] = [];
  removedPerCall = 5;

  async migrate(): Promise<void> {}
  async write(): Promise<void> {}
  async query(_filter: QueryFilter): Promise<MetricPoint[]> {
    return [];
  }
  async latest(): Promise<MetricPoint[]> {
    return [];
  }
  async close(): Promise<void> {}

  async prune(olderThanTs: number): Promise<number> {
    this.pruneCalls.push(olderThanTs);
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
    });

    await pruner.runOnce();

    const expectedCutoff = Math.floor(now / 1000) - 7 * 86_400;
    expect(storage.pruneCalls[0]).toBe(expectedCutoff);
  });

  it("reports how many points were removed", async () => {
    const clock = new FakeClock(localTime("2026-01-01T04:00:00"));
    let reported = -1;

    const pruner = new Pruner({
      storage,
      clock,
      retentionSeconds: 86_400,
      runAt: "04:00",
      onPruned: (removed) => {
        reported = removed;
      },
    });

    await pruner.runOnce();

    expect(reported).toBe(5);
  });
});
