import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeClock, systemClock } from "../clock";
import { WakeWatch } from "../wake-watch";

const HOUR_MS = 3_600_000;

describe("WakeWatch", () => {
  it("counts from the start", () => {
    const clock = new FakeClock(1_000_000);
    const watch = new WakeWatch({ clock });

    clock.advance(HOUR_MS);
    watch.start();
    watch.stop();

    expect(watch.awakeSince).toBe(1_000_000 + HOUR_MS);
  });

  it("keeps the start through ticks on time", () => {
    const clock = new FakeClock(1_000_000);
    const wakes: number[] = [];
    const watch = new WakeWatch({ clock, onWake: (gap) => wakes.push(gap) });

    for (let second = 0; second < 600; second += 1) {
      clock.advance(1000);
      watch.tick();
    }

    expect(watch.awakeSince).toBe(1_000_000);
    expect(wakes).toEqual([]);
  });

  // A laptop lid closed for an hour: no tick fires until it opens.
  it("moves to the tick after a long silence, and says how long", () => {
    const clock = new FakeClock(1_000_000);
    const wakes: number[] = [];
    const watch = new WakeWatch({ clock, onWake: (gap) => wakes.push(gap) });

    clock.advance(1000);
    watch.tick();
    clock.advance(HOUR_MS);
    watch.tick();

    expect(watch.awakeSince).toBe(1_000_000 + 1000 + HOUR_MS);
    expect(wakes).toEqual([HOUR_MS]);

    clock.advance(1000);
    watch.tick();
    expect(wakes).toHaveLength(1);
  });
});

describe("WakeWatch on the system clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks by itself once started, and stops", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const wakes: number[] = [];
    const watch = new WakeWatch({
      clock: systemClock,
      onWake: (gap) => wakes.push(gap),
    });

    watch.start();
    vi.advanceTimersByTime(60_000);
    expect(wakes).toEqual([]);

    // The process was frozen: wall time jumped, no timer fired meanwhile.
    vi.setSystemTime(Date.now() + HOUR_MS);
    vi.advanceTimersByTime(1000);
    expect(wakes).toHaveLength(1);
    expect(watch.awakeSince).toBe(Date.now());

    watch.stop();
    vi.setSystemTime(Date.now() + HOUR_MS);
    vi.advanceTimersByTime(60_000);
    expect(wakes).toHaveLength(1);
  });
});
