import type { ResolvedNode, ResolvedProbe } from "@ephor/core";
import type { Clock } from "./clock.js";
import { slotOf } from "./jitter.js";

export interface Task {
  node: ResolvedNode;
  probe: string;
}

/** What a forced run amounts to: which pairs, and a promise for them alone. */
export interface ForcedRun {
  /** Every pair that will run, in config order. Empty when nothing matched. */
  tasks: Task[];
  /**
   * Probes with a pair that was already mid-run when forced. Such a pair
   * runs again once its current run ends, so it takes up to twice as long
   * as the rest of its probe's queue.
   */
  deferredProbes: ReadonlySet<string>;
  /** Settles once every pair in `tasks` has finished its forced run. */
  finished: Promise<void>;
  /** The pairs whose forced run has not finished yet, in config order. */
  unfinished: () => Task[];
}

/**
 * One `runNow` still waiting. A key moves from `waiting` to `running` when
 * the scheduler dispatches it and leaves `running` when the run completes;
 * the promise settles when both are empty. Two sets rather than one, so
 * that a pair forced twice — once mid-run, once more — settles each run on
 * its own completion instead of the first.
 */
interface RunWaiter {
  waiting: Set<string>;
  running: Set<string>;
  finished: Promise<void>;
  resolve: () => void;
}

export interface SchedulerOptions {
  clock: Clock;
  tickMs?: number;
  onTasksDue: (tasks: Task[]) => void;
}

interface Pair {
  task: Task;
  key: string;
  settings: ResolvedProbe;
}

export class Scheduler {
  /** The interval repetition each pair was last dispatched for. */
  private readonly lastDispatchedSlot = new Map<string, number>();
  /** Pairs that must run on the next tick regardless of their schedule. */
  private readonly forcedKeys = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly runWaiters = new Set<RunWaiter>();
  private timer?: NodeJS.Timeout | undefined;
  private nodes: ResolvedNode[] = [];

  constructor(private readonly options: SchedulerOptions) {}

  setNodes(nodes: ResolvedNode[]): void {
    this.nodes = nodes;

    // A NodeSource may replace the list on every refresh, so per-pair state
    // has to be dropped along with the pairs. Otherwise a fleet that rotates
    // leaves keys behind for every node it ever had.
    const live = new Set<string>();

    for (const { key } of this.pairs()) live.add(key);

    for (const key of this.lastDispatchedSlot.keys()) {
      if (!live.has(key)) this.lastDispatchedSlot.delete(key);
    }

    for (const key of this.forcedKeys) {
      if (!live.has(key)) this.forcedKeys.delete(key);
    }

    // A pair that will never be dispatched — its node gone, or its probe
    // switched off, which `pairs()` treats alike — must not hold a forced
    // run open forever. One already running still completes through
    // `complete()`.
    for (const waiter of this.runWaiters) {
      for (const key of waiter.waiting) {
        if (!live.has(key)) waiter.waiting.delete(key);
      }

      this.settleIfDone(waiter);
    }
  }

  /** How many tasks are running right now. Consumed by /api/health. */
  get runningTasks(): number {
    return this.inFlight.size;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => this.tick(), this.options.tickMs ?? 1000);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Runs the matching pairs on the next tick, ignoring their offsets. This is
   * what `ephor check` is built on, so it must not be expressed by rewinding
   * the schedule — that would only move the pair to its next offset.
   *
   * The promise is for these pairs and nothing else. Waiting for the whole
   * queue to drain instead would hold `check achilles system` hostage to a
   * reachability wave on other nodes, and report a pair that finished in
   * three seconds as not finished at all.
   */
  runNow(nodeName?: string, probeName?: string): ForcedRun {
    const forced: { task: Task; key: string }[] = [];
    const deferredProbes = new Set<string>();

    for (const { task, key } of this.pairs(nodeName, probeName)) {
      this.forcedKeys.add(key);
      forced.push({ task, key });

      if (this.inFlight.has(key)) deferredProbes.add(task.probe);
    }

    // Registered before the tick, so the tick can move the keys it
    // dispatches from waiting to running.
    const waiter = this.awaitRun(forced.map((entry) => entry.key));

    this.tick();

    return {
      tasks: forced.map((entry) => entry.task),
      deferredProbes,
      finished: waiter.finished,
      unfinished: () =>
        forced
          .filter(
            ({ key }) => waiter.waiting.has(key) || waiter.running.has(key),
          )
          .map((entry) => entry.task),
    };
  }

  complete(task: Task): void {
    const key = keyOf(task);

    this.inFlight.delete(key);

    for (const waiter of this.runWaiters) {
      if (waiter.running.delete(key)) this.settleIfDone(waiter);
    }
  }

  tick(): void {
    const now = this.options.clock.now();
    const due: Task[] = [];

    for (const { task, key, settings } of this.pairs()) {
      // A probe slower than its own interval would otherwise queue up
      // copies of itself without bound.
      if (this.inFlight.has(key)) {
        continue;
      }

      const slot = slotOf(now, settings.interval * 1000, key);
      const forced = this.forcedKeys.delete(key);

      if (!forced && !this.isDue(key, slot)) {
        continue;
      }

      this.lastDispatchedSlot.set(key, slot);
      this.inFlight.add(key);
      this.markDispatched(key);
      due.push(task);
    }

    if (due.length > 0) {
      this.options.onTasksDue(due);
    }
  }

  /**
   * Every pair that may run — the enabled probes of the current nodes —
   * narrowed by name when asked. The one place that says what "may run"
   * means, so that forcing, dispatching and forgetting cannot disagree
   * about it.
   */
  private *pairs(nodeName?: string, probeName?: string): Generator<Pair> {
    for (const node of this.nodes) {
      if (nodeName !== undefined && node.node.name !== nodeName) continue;

      for (const [probe, settings] of node.probes) {
        if (!settings.enabled) continue;
        if (probeName !== undefined && probe !== probeName) continue;

        const task = { node, probe };

        yield { task, key: keyOf(task), settings };
      }
    }
  }

  private awaitRun(keys: readonly string[]): RunWaiter {
    let resolve: () => void = () => {};
    const finished = new Promise<void>((settle) => {
      resolve = settle;
    });
    const waiter: RunWaiter = {
      waiting: new Set(keys),
      running: new Set(),
      finished,
      resolve,
    };

    if (keys.length === 0) resolve();
    else this.runWaiters.add(waiter);

    return waiter;
  }

  /**
   * Any dispatch of a forced key is the forced run: the tick consumes the
   * forced flag whether the pair was due on its own or not, and a scheduled
   * run that happens to start now measures exactly what the caller asked
   * for.
   */
  private markDispatched(key: string): void {
    for (const waiter of this.runWaiters) {
      if (waiter.waiting.delete(key)) waiter.running.add(key);
    }
  }

  private settleIfDone(waiter: RunWaiter): void {
    if (waiter.waiting.size > 0 || waiter.running.size > 0) return;

    this.runWaiters.delete(waiter);
    waiter.resolve();
  }

  private isDue(key: string, slot: number): boolean {
    const previous = this.lastDispatchedSlot.get(key);

    // First sight of this pair: remember where the schedule stands rather
    // than running immediately, so the first run lands on the pair's own
    // offset instead of joining everyone else's startup burst.
    if (previous === undefined) {
      this.lastDispatchedSlot.set(key, slot);

      return false;
    }

    return slot > previous;
  }
}

function keyOf(task: Task): string {
  // A separator neither part can contain, so two different pairs cannot
  // collide into one key. Written as an escape: a raw control byte in
  // source makes git treat the file as binary and hides every diff.
  return `${task.node.node.name}\u0000${task.probe}`;
}
