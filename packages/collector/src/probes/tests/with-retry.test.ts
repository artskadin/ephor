import type { Probe, ProbeContext, ProbeDescriptor } from "@ephor/core";
import { describe, expect, it } from "vitest";
import { sleep } from "../../scheduling/clock.js";
import { longestRunMs, RETRY_DELAY_MS, runWithRetry } from "../with-retry.js";

const DESCRIPTOR: ProbeDescriptor = {
  name: "flaky",
  requiresExecutor: false,
  enabledByDefault: true,
  defaults: { interval: 60, timeout: 1, retries: 2, concurrency: 1 },
};

const CONTEXT: ProbeContext = {
  nodeName: "pupa",
  host: "203.0.113.10",
  ports: [],
  startedAt: 0,
  timeoutMs: 20,
  settings: {},
};

/** Fails every attempt with a transient error, taking `attemptMs` each time. */
function failingProbe(attemptMs: number): Probe<never> & { runs: number } {
  const probe = {
    descriptor: DESCRIPTOR,
    runs: 0,
    async run() {
      probe.runs += 1;
      await sleep(attemptMs);

      return {
        ok: false as const,
        error: { kind: "timeout" as const },
        durationMs: attemptMs,
      };
    },
    toMetrics: () => [],
  };

  return probe;
}

describe("longestRunMs", () => {
  it("is the timeout alone when there are no retries", () => {
    expect(longestRunMs(15_000, 0)).toBe(15_000);
  });

  // Two retries: three attempts of 15 s, a 1 s pause before the second
  // attempt and a 2 s pause before the third.
  it("adds every attempt and the growing pauses between them", () => {
    expect(RETRY_DELAY_MS).toBe(1000);
    expect(longestRunMs(15_000, 2)).toBe(45_000 + 1_000 + 2_000);
  });

  it("is what a run that fails every attempt actually takes", async () => {
    const probe = failingProbe(20);
    const before = performance.now();

    const outcome = await runWithRetry(probe, CONTEXT, 2, 10);

    const elapsed = performance.now() - before;

    expect(outcome.ok).toBe(false);
    expect(probe.runs).toBe(3);
    // Five timers in a row; each may fire up to a millisecond early.
    expect(elapsed).toBeGreaterThanOrEqual(longestRunMs(20, 2, 10) - 5);
  });
});
