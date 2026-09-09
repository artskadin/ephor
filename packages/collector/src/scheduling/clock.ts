import { setTimeout as timerAfter } from "node:timers/promises";

export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** Rejects at once, timer cleared, when `signal` aborts. */
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
