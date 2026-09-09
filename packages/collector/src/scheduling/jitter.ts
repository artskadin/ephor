// Each pair runs at its own offset inside the interval, from a hash rather
// than a random number: the schedule survives restarts, and adding a node
// moves nobody else. Prometheus staggers scrapes the same way.

/** FNV-1a, 32-bit. */
export function fnv1aHash(value: string): number {
  let hash = 2_166_136_261;

  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return hash >>> 0;
}

/** Always in [0, intervalMs). */
export function scheduleOffsetMs(key: string, intervalMs: number): number {
  return fnv1aHash(key) % intervalMs;
}

// Anchored to the epoch, not to the previous run, so offsets cannot drift
// and a collector down for an hour resumes with one run, not sixty.
export function intervalSlotAt(
  nowMs: number,
  intervalMs: number,
  key: string,
): number {
  return Math.floor((nowMs - scheduleOffsetMs(key, intervalMs)) / intervalMs);
}
