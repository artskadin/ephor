import { describe, expect, it } from "vitest";
import { hashOf, scheduleOffsetMs, slotOf } from "../jitter.js";

const MINUTE = 60_000;

const NODES = [
  "achilles",
  "antilochus",
  "leonidas",
  "german",
  "hector",
  "ajax",
  "odysseus",
  "patroclus",
  "diomedes",
  "nestor",
  "priam",
  "paris",
];

describe("hashOf", () => {
  it("is stable for the same input", () => {
    expect(hashOf("achilles system")).toBe(hashOf("achilles system"));
  });

  it("separates inputs that differ by one character", () => {
    expect(hashOf("achilles system")).not.toBe(hashOf("achilles systen"));
  });

  it("stays a non-negative 32-bit integer", () => {
    for (const node of NODES) {
      const hash = hashOf(node);

      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThan(2 ** 32);
    }
  });
});

describe("scheduleOffsetMs", () => {
  it("never reaches the interval it divides", () => {
    for (const node of NODES) {
      const offset = scheduleOffsetMs(`${node} system`, MINUTE);

      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(MINUTE);
    }
  });

  // The point of hashing rather than randomising: a restart must not
  // reshuffle the schedule, or "it was worse at 3am" stops being repeatable.
  it("gives the same offset every time it is asked", () => {
    const first = NODES.map((node) => scheduleOffsetMs(node, MINUTE));
    const second = NODES.map((node) => scheduleOffsetMs(node, MINUTE));

    expect(second).toEqual(first);
  });

  // With offsets assigned by position, adding one node would shift the
  // schedule of every node after it.
  it("does not move existing keys when another key appears", () => {
    const before = NODES.map((node) => scheduleOffsetMs(node, MINUTE));
    const after = [...NODES, "menelaus"].map((node) =>
      scheduleOffsetMs(node, MINUTE),
    );

    expect(after.slice(0, NODES.length)).toEqual(before);
  });

  // Otherwise one node would take an ssh connection, an API check and a
  // download all in the same instant.
  it("separates the probes of a single node", () => {
    for (const node of NODES) {
      const system = scheduleOffsetMs(`${node} system`, MINUTE);
      const reachability = scheduleOffsetMs(`${node} reachability`, MINUTE);

      expect(system).not.toBe(reachability);
    }
  });

  it("spreads a fleet across the interval instead of stacking it", () => {
    const fleetSize = 200;
    const perSecond = new Map<number, number>();

    for (let index = 0; index < fleetSize; index++) {
      const second = Math.floor(
        scheduleOffsetMs(`node-${index} system`, MINUTE) / 1000,
      );

      perSecond.set(second, (perSecond.get(second) ?? 0) + 1);
    }

    // Collisions are expected and harmless — several nodes in one second is
    // what the concurrency limit exists to absorb. What must not happen is a
    // stampede: without jitter every one of these would share one second.
    expect(Math.max(...perSecond.values())).toBeLessThan(fleetSize / 10);
    // And the spread has to cover the interval, not crowd into a corner.
    expect(perSecond.size).toBeGreaterThan(40);
  });
});

describe("slotOf", () => {
  it("advances by exactly one per interval", () => {
    const start = Date.parse("2026-08-29T04:00:00.000Z");
    const key = "achilles system";

    expect(slotOf(start + MINUTE, MINUTE, key)).toBe(
      slotOf(start, MINUTE, key) + 1,
    );
    expect(slotOf(start + 10 * MINUTE, MINUTE, key)).toBe(
      slotOf(start, MINUTE, key) + 10,
    );
  });

  it("holds the same slot for the whole interval", () => {
    const start = Date.parse("2026-08-29T04:00:00.000Z");
    const key = "achilles system";
    const slot = slotOf(start, MINUTE, key);

    // Walk to just before the next boundary; the slot must not have moved.
    const boundaries: number[] = [];

    for (let elapsed = 0; elapsed < MINUTE; elapsed += 1000) {
      boundaries.push(slotOf(start + elapsed, MINUTE, key));
    }

    expect(new Set(boundaries).size).toBeLessThanOrEqual(2);
    expect(boundaries[0]).toBe(slot);
  });

  // Anchored to absolute time, so a thousand cycles land on the same phase
  // as the first one rather than creeping forward by a tick each time.
  it("does not drift over many intervals", () => {
    const start = Date.parse("2026-08-29T04:00:00.000Z");
    const key = "achilles system";

    expect(slotOf(start + 1000 * MINUTE, MINUTE, key)).toBe(
      slotOf(start, MINUTE, key) + 1000,
    );
  });
});
