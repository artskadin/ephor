import { type ProbeDescriptor, parseConfig, resolveConfig } from "@ephor/core";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeClock, sleep } from "../clock.js";
import { Scheduler, type Task } from "../scheduler.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const PROBES: ProbeDescriptor[] = [
  {
    name: "fast",
    requiresExecutor: false,
    enabledByDefault: true,
    defaults: { interval: 60, timeout: 10, retries: 0, concurrency: 50 },
  },
  {
    name: "slow",
    requiresExecutor: false,
    enabledByDefault: true,
    defaults: { interval: 300, timeout: 10, retries: 0, concurrency: 50 },
  },
];

function nodesFor(
  names: readonly string[],
  probes: Record<string, { enabled: boolean }> = {},
) {
  const config = parseConfig(
    { nodes: names.map((name) => ({ name, host: "203.0.113.10", probes })) },
    PROBES,
  );

  return resolveConfig(config, PROBES);
}

describe("Scheduler", () => {
  let clock: FakeClock;
  let dispatched: Task[];
  let scheduler: Scheduler;

  beforeEach(() => {
    clock = new FakeClock(Date.parse("2026-08-29T04:00:00.000Z"));
    dispatched = [];
    scheduler = new Scheduler({
      clock,
      onTasksDue: (tasks) => dispatched.push(...tasks),
    });
    scheduler.setNodes(nodesFor(["pupa"]));
  });

  /** Ticks once per second, completing every task so the next one may run. */
  function runFor(milliseconds: number): void {
    for (let elapsed = 0; elapsed < milliseconds; elapsed += SECOND) {
      scheduler.tick();

      for (const task of dispatched) scheduler.complete(task);

      clock.advance(SECOND);
    }
  }

  function probeNames(): string[] {
    return dispatched.map((task) => task.probe);
  }

  function countOf(probe: string): number {
    return probeNames().filter((name) => name === probe).length;
  }

  it("does not run everything the moment it starts", () => {
    scheduler.tick();

    expect(dispatched).toEqual([]);
  });

  it("runs each probe exactly once per interval", () => {
    runFor(10 * MINUTE);

    expect(countOf("fast")).toBe(10);
    expect(countOf("slow")).toBe(2);
  });

  // The schedule is anchored to absolute time, so the tick granularity does
  // not accumulate into a drift across the day.
  it("keeps the same count over a hundred intervals", () => {
    runFor(100 * MINUTE);

    expect(countOf("fast")).toBe(100);
  });

  it("spreads a fleet instead of starting it in lockstep", () => {
    scheduler.setNodes(
      nodesFor([
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
      ]),
    );

    const perTick: number[] = [];

    // Inclusive of the closing boundary: an offset landing in the interval's
    // final second is first observed by the tick at the minute mark.
    for (let elapsed = 0; elapsed <= MINUTE; elapsed += SECOND) {
      const before = dispatched.length;

      scheduler.tick();
      for (const task of dispatched) scheduler.complete(task);
      clock.advance(SECOND);

      perTick.push(dispatched.length - before);
    }

    const nodesSeen = new Set(dispatched.map((task) => task.node.node.name));

    // Every node is reached within the interval...
    expect(nodesSeen.size).toBe(12);
    // ...and never all in the same second. Without jitter this would be 12.
    expect(Math.max(...perTick)).toBeLessThan(12);
  });

  it("does not re-run a task that is still in flight", () => {
    // Nothing is completed here, so the pair stays busy throughout.
    for (let elapsed = 0; elapsed < 5 * MINUTE; elapsed += SECOND) {
      scheduler.tick();
      clock.advance(SECOND);
    }

    expect(countOf("fast")).toBe(1);
  });

  // A collector that was down should resume, not replay the outage.
  it("runs once after a long gap rather than catching up", () => {
    runFor(2 * MINUTE);
    dispatched = [];

    clock.advance(10 * MINUTE);
    scheduler.tick();

    expect(countOf("fast")).toBe(1);
  });

  // setNodes exists so a NodeSource can replace the list at runtime; a fleet
  // that rotates must not leave per-pair state behind for every node it ever
  // had.
  it("forgets nodes that are no longer in the list", () => {
    scheduler.setNodes(nodesFor(["pupa", "lupa"]));
    runFor(2 * MINUTE);

    scheduler.setNodes(nodesFor(["pupa"]));
    dispatched = [];
    runFor(2 * MINUTE);

    expect(dispatched.map((task) => task.node.node.name)).not.toContain("lupa");
    // Re-adding it starts the schedule over rather than resuming a stale slot.
    scheduler.setNodes(nodesFor(["pupa", "lupa"]));
    dispatched = [];
    scheduler.tick();

    expect(dispatched).toEqual([]);
  });

  it("never runs a probe that is switched off", () => {
    const config = parseConfig(
      {
        probes: { slow: { enabled: false } },
        nodes: [{ name: "pupa", host: "203.0.113.10" }],
      },
      PROBES,
    );

    scheduler.setNodes(resolveConfig(config, PROBES));
    runFor(10 * MINUTE);

    expect(probeNames()).not.toContain("slow");
  });

  describe("runNow", () => {
    it("ignores the offset and runs immediately", () => {
      scheduler.runNow();

      expect(probeNames().sort()).toEqual(["fast", "slow"]);
    });

    it("limits the run to one node", () => {
      scheduler.setNodes(nodesFor(["pupa", "lupa"]));

      scheduler.runNow("pupa");

      expect(dispatched.map((task) => task.node.node.name)).toEqual([
        "pupa",
        "pupa",
      ]);
    });

    it("limits the run to one probe of one node", () => {
      scheduler.runNow("pupa", "slow");

      expect(probeNames()).toEqual(["slow"]);
    });

    it("leaves the regular schedule alone afterwards", () => {
      scheduler.runNow("pupa", "fast");
      for (const task of dispatched) scheduler.complete(task);
      dispatched = [];

      runFor(10 * MINUTE);

      expect(countOf("fast")).toBe(10);
    });
  });

  describe("a forced run", () => {
    /** Whether a promise has settled, once every pending microtask has run. */
    async function isSettled(promise: Promise<void>): Promise<boolean> {
      let settled = false;

      void promise.then(() => {
        settled = true;
      });
      await sleep(0);

      return settled;
    }

    function firstDispatched(): Task {
      const task = dispatched[0];
      if (!task) throw new Error("expected a task to be dispatched");

      return task;
    }

    const pairOf = (task: Task): string =>
      `${task.node.node.name}/${task.probe}`;

    it("hands back the pairs it forced, in config order", () => {
      scheduler.setNodes(nodesFor(["pupa", "lupa"]));

      const run = scheduler.runNow("lupa");

      expect(run.tasks.map(pairOf)).toEqual(["lupa/fast", "lupa/slow"]);
      expect(run.deferredProbes).toEqual(new Set());
    });

    it("says which of its pairs are still unfinished", () => {
      const run = scheduler.runNow();
      const [first, second] = dispatched;
      if (!first || !second) throw new Error("expected two tasks");

      expect(run.unfinished().map(pairOf)).toEqual(["pupa/fast", "pupa/slow"]);

      scheduler.complete(first);
      expect(run.unfinished().map(pairOf)).toEqual(["pupa/slow"]);

      scheduler.complete(second);
      expect(run.unfinished()).toEqual([]);
    });

    it("settles at once when nothing matched", async () => {
      const run = scheduler.runNow("nobody");

      expect(run.tasks).toEqual([]);
      await expect(run.finished).resolves.toBeUndefined();
    });

    // `check achilles system` must not wait out a reachability wave on
    // every other node: the promise is for the pairs asked for, not for the
    // queue.
    it("settles when its own pairs finish, whatever else is running", async () => {
      scheduler.setNodes(nodesFor(["pupa", "lupa"]));
      scheduler.runNow("lupa");
      dispatched = [];

      const run = scheduler.runNow("pupa");

      for (const task of dispatched) scheduler.complete(task);

      expect(scheduler.runningTasks).toBe(2);
      await expect(run.finished).resolves.toBeUndefined();
    });

    it("stays open until the last of its pairs is done", async () => {
      const run = scheduler.runNow();
      const [first, second] = dispatched;
      if (!first || !second) throw new Error("expected two tasks");

      scheduler.complete(first);
      expect(await isSettled(run.finished)).toBe(false);

      scheduler.complete(second);
      expect(await isSettled(run.finished)).toBe(true);
    });

    // `ephor check` on a node whose probe happens to be mid-cycle must not
    // be handed the previous cycle's numbers as the fresh ones it asked for.
    it("reports a pair that is mid-run as deferred and waits for its next run", async () => {
      scheduler.runNow("pupa", "fast");
      const running = firstDispatched();
      dispatched = [];

      // The user asks for a fresh run while that one is still going.
      const run = scheduler.runNow("pupa", "fast");

      expect(run.deferredProbes).toEqual(new Set(["fast"]));

      scheduler.complete(running);
      expect(dispatched).toHaveLength(0);
      expect(await isSettled(run.finished)).toBe(false);

      // Only the tick that actually starts the forced run, and its
      // completion, may end the wait.
      scheduler.tick();
      expect(dispatched).toHaveLength(1);

      for (const task of dispatched) scheduler.complete(task);

      await expect(run.finished).resolves.toBeUndefined();
    });

    // Two clients checking the same node: the first must get its answer
    // when its run ends, not when the second one's does.
    it("settles two overlapping runs of one pair each on its own completion", async () => {
      const first = scheduler.runNow("pupa", "fast");
      const firstTask = firstDispatched();
      dispatched = [];

      const second = scheduler.runNow("pupa", "fast");

      scheduler.complete(firstTask);
      expect(await isSettled(first.finished)).toBe(true);
      expect(await isSettled(second.finished)).toBe(false);

      scheduler.tick();
      for (const task of dispatched) scheduler.complete(task);

      expect(await isSettled(second.finished)).toBe(true);
    });

    it("does not stay open for a pair whose node was removed before it ran", async () => {
      scheduler.runNow("pupa", "fast");
      dispatched = [];

      const run = scheduler.runNow("pupa", "fast");
      expect(run.deferredProbes.size).toBe(1);

      scheduler.setNodes(nodesFor(["lupa"]));

      await expect(run.finished).resolves.toBeUndefined();
    });

    // A refresh that switches the probe off leaves the pair in the node's
    // map, marked disabled; the tick will never dispatch it, so the run
    // must not wait for it either.
    it("lets go of a pair whose probe was switched off before it ran", async () => {
      scheduler.runNow("pupa", "fast");
      dispatched = [];

      const run = scheduler.runNow("pupa", "fast");
      expect(run.deferredProbes).toEqual(new Set(["fast"]));

      scheduler.setNodes(nodesFor(["pupa"], { fast: { enabled: false } }));

      await expect(run.finished).resolves.toBeUndefined();
      expect(run.unfinished()).toEqual([]);
    });
  });
});
