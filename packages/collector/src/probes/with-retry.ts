import type { Probe, ProbeContext, ProbeOutcome } from "@ephorate/core";
import { sleep } from "../scheduling/clock.js";

/** Auth and configuration errors fail the same way again; only these retry. */
const TRANSIENT_KINDS = new Set(["timeout", "unreachable", "internal"]);

/** Before the first retry; each later one waits one step more. */
export const RETRY_DELAY_MS = 1000;

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

/** Every attempt using its whole timeout, with the pauses in between. */
export function longestRunMs(
  timeoutMs: number,
  retries: number,
  delayMs = RETRY_DELAY_MS,
): number {
  const pauses = (delayMs * retries * (retries + 1)) / 2;

  return timeoutMs * (1 + retries) + pauses;
}
