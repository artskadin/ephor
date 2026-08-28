import type { Probe, ProbeContext, ProbeOutcome } from "@ephor/core";

/** Failures worth retrying: transient by nature. */
const TRANSIENT_KINDS = new Set(["timeout", "unreachable", "internal"]);

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
  delayMs = 1000,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
