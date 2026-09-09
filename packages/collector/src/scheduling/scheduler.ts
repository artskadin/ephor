import type { ResolvedNode, ResolvedProbe } from "@ephorate/core";
import type { Clock } from "./clock.js";
import { intervalSlotAt } from "./jitter.js";

export interface Task {
  node: ResolvedNode;
  probe: string;
}

export interface ForcedRun {
  /** In config order; empty when nothing matched. */
  tasks: Task[];
  /** Probes with a pair mid-run when forced: it runs again, one wave more. */
  deferredProbes: ReadonlySet<string>;
  /** Settles once every pair in `tasks` has finished its forced run. */
  finished: Promise<void>;
  unfinished: () => Task[];
}

// A key moves from `waiting` to `running` on dispatch and leaves on
// completion; two sets so a pair forced mid-run settles on its own run.
interface RunWaiter {
  waiting: Set<string>;
  running: Set<string>;
  finished: Promise<void>;
  resolve: () => void;
}

interface SchedulerOptions {
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
  private readonly forcedKeys = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly runWaiters = new Set<RunWaiter>();
  private timer?: NodeJS.Timeout | undefined;
  private nodes: ResolvedNode[] = [];

  constructor(private readonly options: SchedulerOptions) {}

  setNodes(nodes: ResolvedNode[]): void {
    this.nodes = nodes;

    // Per-pair state goes with the pairs, or a rotating fleet leaves keys
    // behind for every node it ever had.
    const live = new Set<string>();

    for (const { key } of this.pairs()) live.add(key);

    for (const key of this.lastDispatchedSlot.keys()) {
      if (!live.has(key)) this.lastDispatchedSlot.delete(key);
    }

    for (const key of this.forcedKeys) {
      if (!live.has(key)) this.forcedKeys.delete(key);
    }

    // A pair that will never be dispatched must not hold a forced run open.
    for (const waiter of this.runWaiters) {
      for (const key of waiter.waiting) {
        if (!live.has(key)) waiter.waiting.delete(key);
      }

      this.settleIfDone(waiter);
    }
  }

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

  // Runs the matching pairs on the next tick, offsets ignored. The promise
  // is for these pairs alone: the whole queue would hold `check achilles
  // system` hostage to a reachability wave on other nodes.
  runNow(nodeName?: string, probeName?: string): ForcedRun {
    const forced: { task: Task; key: string }[] = [];
    const deferredProbes = new Set<string>();

    for (const { task, key } of this.pairs(nodeName, probeName)) {
      this.forcedKeys.add(key);
      forced.push({ task, key });

      if (this.inFlight.has(key)) deferredProbes.add(task.probe);
    }

    // Before the tick, so the tick can move dispatched keys to running.
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
    const key = pairKey(task);

    this.inFlight.delete(key);

    for (const waiter of this.runWaiters) {
      if (waiter.running.delete(key)) this.settleIfDone(waiter);
    }
  }

  tick(): void {
    const now = this.options.clock.now();
    const due: Task[] = [];

    for (const { task, key, settings } of this.pairs()) {
      // A probe slower than its interval must not queue copies of itself.
      if (this.inFlight.has(key)) {
        continue;
      }

      const slot = intervalSlotAt(now, settings.interval * 1000, key);
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

  /** The one definition of "may run": forcing and dispatching agree. */
  private *pairs(nodeName?: string, probeName?: string): Generator<Pair> {
    for (const node of this.nodes) {
      if (nodeName !== undefined && node.node.name !== nodeName) continue;

      for (const [probe, settings] of node.probes) {
        if (!settings.enabled) continue;
        if (probeName !== undefined && probe !== probeName) continue;

        const task = { node, probe };

        yield { task, key: pairKey(task), settings };
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

  /** Any dispatch of a forced key is the forced run, due on its own or not. */
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

    // A new pair waits for its own offset instead of joining a startup burst.
    if (previous === undefined) {
      this.lastDispatchedSlot.set(key, slot);

      return false;
    }

    return slot > previous;
  }
}

// A separator neither part can contain, written as an escape: a raw control
// byte makes git treat the file as binary.
function pairKey(task: Task): string {
  return `${task.node.node.name}\u0000${task.probe}`;
}
