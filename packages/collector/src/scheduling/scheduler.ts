import type { ResolvedNode } from "@ephor/core";
import type { Clock } from "./clock.js";

export interface Task {
  node: ResolvedNode;
  probe: string;
}

export interface SchedulerOptions {
  clock: Clock;
  tickMs?: number;
  onDue: (tasks: Task[]) => void;
}

export class Scheduler {
  private readonly lastRun = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private timer?: NodeJS.Timeout | undefined;
  private nodes: ResolvedNode[] = [];

  constructor(private readonly options: SchedulerOptions) {}

  setNodes(nodes: ResolvedNode[]) {
    this.nodes = nodes;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => this.tick(), this.options.tickMs ?? 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  runNow(nodeName?: string, probe?: string): void {
    for (const key of this.lastRun.keys()) {
      const [n, p] = key.split("\u0000");

      if (nodeName && n !== nodeName) continue;

      if (probe && p !== probe) continue;

      this.lastRun.delete(key);
    }

    this.tick();
  }

  complete(task: Task): void {
    this.inFlight.delete(keyOf(task));
  }

  tick(): void {
    const now = this.options.clock.now();
    const due: Task[] = [];

    for (const node of this.nodes) {
      for (const [probe, check] of node.checks) {
        if (!check.enabled) {
          continue;
        }

        const task = { node, probe };
        const key = keyOf(task);

        if (this.inFlight.has(key)) {
          continue;
        }

        const last = this.lastRun.get(key) ?? 0;

        if (now - last < check.interval * 1000) {
          continue;
        }

        this.lastRun.set(key, now);
        this.inFlight.add(key);
        due.push(task);
      }
    }

    if (due.length > 0) {
      this.options.onDue(due);
    }
  }
}

function keyOf(task: Task): string {
  return `${task.node.node.name}\u0000${task.probe}`;
}
