import type { Probe, ProbeContext, ProbeOutcome } from "@ephor/core";
import { sleep } from "../scheduling/clock.js";

/** Failures worth retrying: transient by nature. */
const TRANSIENT_KINDS = new Set(["timeout", "unreachable", "internal"]);

/** The pause before the first retry; each later one waits one step more. */
export const RETRY_DELAY_MS = 1000;

/**
 * Runs a probe again after a transient failure.
 *
 * Retrying auth or configuration errors is pointless — they will
 * fail identically — so only network-ish failures are repeated.
 */
export async function runWithRetry<T>(
  probe: Probe<T>,
  context: ProbeContext,
  attempts: number,
  delayMs = RETRY_DELAY_MS,
): Promise<ProbeOutcome<T>> {
  let lastOutcome = await probe.run(context);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (lastOutcome.ok) return lastOutcome;
    if (!TRANSIENT_KINDS.has(lastOutcome.error.kind)) return lastOutcome;

    await sleep(delayMs * attempt);
    lastOutcome = await probe.run(context);
  }

  return lastOutcome;
}

/**
 * The longest a run through `runWithRetry` can take: every attempt using
 * its whole timeout, with the pauses in between. What a caller waiting for
 * a run must be prepared to wait, or it gives up seconds before the last
 * attempt lands.
 */
export function longestRunMs(
  timeoutMs: number,
  retries: number,
  delayMs = RETRY_DELAY_MS,
): number {
  const pauses = (delayMs * retries * (retries + 1)) / 2;

  return timeoutMs * (1 + retries) + pauses;
}
