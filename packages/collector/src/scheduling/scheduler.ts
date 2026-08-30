import type { ResolvedNode } from "@ephor/core";
import type { Clock } from "./clock.js";
import { slotOf } from "./jitter.js";

export interface Task {
  node: ResolvedNode;
  probe: string;
}

export interface SchedulerOptions {
  clock: Clock;
  tickMs?: number;
  onTasksDue: (tasks: Task[]) => void;
}

/** Resolved when the queue drains, or false when the wait timed out. */
type IdleWaiter = (idle: boolean) => void;

export class Scheduler {
  /** The interval repetition each pair was last dispatched for. */
  private readonly lastDispatchedSlot = new Map<string, number>();
  /** Pairs that must run on the next tick regardless of their schedule. */
  private readonly forcedKeys = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly idleWaiters = new Set<IdleWaiter>();
  private timer?: NodeJS.Timeout | undefined;
  private nodes: ResolvedNode[] = [];

  constructor(private readonly options: SchedulerOptions) {}

  setNodes(nodes: ResolvedNode[]): void {
    this.nodes = nodes;

    // A NodeSource may replace the list on every refresh, so per-pair state
    // has to be dropped along with the pairs. Otherwise a fleet that rotates
    // leaves keys behind for every node it ever had.
    const live = new Set<string>();

    for (const node of nodes) {
      for (const probe of node.probes.keys()) live.add(keyOf({ node, probe }));
    }

    for (const key of this.lastDispatchedSlot.keys()) {
      if (!live.has(key)) this.lastDispatchedSlot.delete(key);
    }

    for (const key of this.forcedKeys) {
      if (!live.has(key)) this.forcedKeys.delete(key);
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
   */
  runNow(nodeName?: string, probeName?: string): void {
    for (const node of this.nodes) {
      if (nodeName !== undefined && node.node.name !== nodeName) continue;

      for (const [probe, settings] of node.probes) {
        if (!settings.enabled) continue;
        if (probeName !== undefined && probe !== probeName) continue;

        this.forcedKeys.add(keyOf({ node, probe }));
      }
    }

    this.tick();
  }

  complete(task: Task): void {
    this.inFlight.delete(keyOf(task));

    if (!this.isIdle()) return;

    // Copied first: a waiter removes itself from the set as it settles.
    for (const waiter of [...this.idleWaiters]) waiter(true);
  }

  /**
   * Resolves true once nothing is running, false if that did not happen in
   * time. `POST /api/check` forces a run and then waits on this before
   * reading the fresh state back.
   */
  waitUntilIdle(timeoutMs: number): Promise<boolean> {
    if (this.isIdle()) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      let timer: NodeJS.Timeout | undefined;

      const settle: IdleWaiter = (idle) => {
        if (timer) clearTimeout(timer);
        this.idleWaiters.delete(settle);
        resolve(idle);
      };

      timer = setTimeout(() => settle(false), timeoutMs);
      this.idleWaiters.add(settle);
    });
  }

  tick(): void {
    const now = this.options.clock.now();
    const due: Task[] = [];

    for (const node of this.nodes) {
      for (const [probe, settings] of node.probes) {
        if (!settings.enabled) {
          continue;
        }

        const task = { node, probe };
        const key = keyOf(task);

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
        due.push(task);
      }
    }

    if (due.length > 0) {
      this.options.onTasksDue(due);
    }
  }

  /**
   * Idle means nothing is running *and* nothing is still owed a run. A pair
   * forced while it was already in flight has its run deferred to a later
   * tick, and reporting idle in between would tell `ephor check` that the
   * previous cycle's numbers are the fresh ones it asked for.
   */
  private isIdle(): boolean {
    return this.inFlight.size === 0 && this.forcedKeys.size === 0;
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
