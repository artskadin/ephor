/**
 * Spreads recurring work over its own interval.
 *
 * Without this, every node/probe pair becomes due on the same tick and stays
 * in lockstep forever: a burst of ssh connections, a burst of API calls, and
 * a set of measurements that claim to be one snapshot while having been
 * taken minutes apart.
 *
 * The offset comes from a hash of the pair rather than from a random number,
 * which buys three things: the schedule survives a restart unchanged, adding
 * a node leaves every other node's slot alone, and the two probes of one node
 * do not land on the same instant. Prometheus staggers its scrapes the same
 * way — `offset = hash(target) % interval` in `scrape/target.go`.
 */

/** FNV-1a, 32-bit. Small, fast, and good enough for spreading. */
export function hashOf(value: string): number {
  let hash = 2_166_136_261;

  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    // Multiplication that stays within 32 bits.
    hash = Math.imul(hash, 16_777_619);
  }

  return hash >>> 0;
}

/** Where inside its interval this key runs. Always in [0, intervalMs). */
export function scheduleOffsetMs(key: string, intervalMs: number): number {
  return hashOf(key) % intervalMs;
}

/**
 * Which repetition of the interval the given moment falls into.
 *
 * Anchored to absolute time rather than to the previous run: a scheduler that
 * measures "interval elapsed since last dispatch" adds the tick granularity
 * to every cycle, so the carefully spread offsets drift apart over a day. A
 * slot computed from the epoch cannot drift, and a collector that was down
 * for an hour resumes with one run rather than catching up on sixty.
 */
export function slotOf(nowMs: number, intervalMs: number, key: string): number {
  return Math.floor((nowMs - scheduleOffsetMs(key, intervalMs)) / intervalMs);
}
