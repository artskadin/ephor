import type { Storage } from "@ephor/core";
import type { Clock } from "../scheduling/clock.js";

export interface PrunerOptions {
  storage: Storage;
  clock: Clock;
  /** Seconds of history to keep. */
  retentionSeconds: number;
  /** Local time of day to run, as 'HH:MM'. */
  runAt: string;
  onPruned?: ((removed: number) => void) | undefined;
}

/**
 * Deletes old metrics once a day.
 */
export class Pruner {
  private timer?: NodeJS.Timeout | undefined;
  private lastRunDay = "";

  constructor(private readonly options: PrunerOptions) {}

  start(): void {
    if (this.timer) return;
    // Checking every minute is precise enough for a daily job and
    // survives clock drift better than a single long timeout.
    this.timer = setInterval(() => void this.tick(), 60_000);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    const now = new Date(this.options.clock.now());
    const today = now.toISOString().slice(0, 10);

    if (this.lastRunDay === today) return;
    if (formatTime(now) !== this.options.runAt) return;

    this.lastRunDay = today;
    await this.runOnce();
  }

  /** Exposed for manual runs and tests. */
  async runOnce(): Promise<number> {
    const cutoff =
      Math.floor(this.options.clock.now() / 1000) -
      this.options.retentionSeconds;

    const removed = await this.options.storage.prune(cutoff);
    this.options.onPruned?.(removed);

    return removed;
  }
}

function formatTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}
