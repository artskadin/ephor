import { describe, expect, it } from "vitest";
import { sleep, systemClock } from "../clock.js";

describe("systemClock", () => {
  it("reads the wall clock in milliseconds", () => {
    const before = Date.now();
    const read = systemClock.now();

    expect(read).toBeGreaterThanOrEqual(before);
    expect(read).toBeLessThanOrEqual(Date.now());
  });
});

describe("sleep", () => {
  it("resolves no earlier than asked", async () => {
    const before = performance.now();

    await sleep(20);

    // Node rounds timers to whole milliseconds, so a timer may fire up to
    // one millisecond before a sub-millisecond clock says it should.
    expect(performance.now() - before).toBeGreaterThanOrEqual(19);
  });

  // The losing side of a race must not keep its timer: a check that took
  // three seconds would otherwise leave a four-minute handle in the loop.
  it("gives up at once when aborted, rejecting rather than resolving", async () => {
    const controller = new AbortController();
    const before = performance.now();
    const sleeping = sleep(60_000, controller.signal);

    controller.abort();

    await expect(sleeping).rejects.toThrow(/abort/i);
    expect(performance.now() - before).toBeLessThan(1000);
  });

  it("does not resolve synchronously", async () => {
    let done = false;
    const sleeping = sleep(1).then(() => {
      done = true;
    });

    await Promise.resolve();
    expect(done).toBe(false);

    await sleeping;
    expect(done).toBe(true);
  });
});
