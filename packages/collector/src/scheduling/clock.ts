import { setTimeout as timerAfter } from "node:timers/promises";

export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/**
 * Resolves after `ms`; rejects at once, timer cleared, when `signal` aborts.
 * The default behind every injected `sleep`, and the companion of
 * `systemClock`: a test that freezes one has to hold the other, or the two
 * disagree about how much time has passed.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return timerAfter(ms, undefined, signal ? { signal } : {});
}

export class FakeClock implements Clock {
  constructor(private current = 0) {}

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
