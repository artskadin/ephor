import type { Logger, Storage } from "@ephorate/core";
import type { Clock } from "../scheduling/clock";

interface PrunerOptions {
  storage: Storage;
  clock: Clock;
  retentionSeconds: number;
  /** Local time of day, `HH:MM`. */
  runAt: string;
  /** Configured and enabled: the API reaches no other node's. */
  nodeNames: readonly string[];
  logger: Logger;
}

interface PruneReport {
  metrics: number;
  acknowledgementsExpired: number;
  acknowledgementsOrphaned: number;
}

/** Once a day: old metrics, and acknowledgements nothing can reach. */
export class Pruner {
  private timer?: NodeJS.Timeout | undefined;
  private lastRunDay = "";

  constructor(private readonly options: PrunerOptions) {}

  start(): void {
    if (this.timer) return;
    // A minute is precise enough for a daily job and survives clock drift.
    this.timer = setInterval(() => void this.tick(), 60_000);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // Never rejects: under `void` in a timer, a rejection exits the process.
  async tick(): Promise<void> {
    const now = new Date(this.options.clock.now());
    const today = now.toISOString().slice(0, 10);

    if (this.lastRunDay === today) return;
    if (formatTime(now) !== this.options.runAt) return;

    this.lastRunDay = today;
    try {
      await this.runOnce();
    } catch (cause) {
      this.options.logger.error("pruning failed, next try tomorrow", {
        cause,
      });
    }
  }

  async runOnce(): Promise<PruneReport> {
    const { storage } = this.options;
    const now = Math.floor(this.options.clock.now() / 1000);

    const metrics = await storage.prune(now - this.options.retentionSeconds);
    const acknowledgementsExpired = await storage.expireAcknowledgements(now);

    const configured = new Set(this.options.nodeNames);
    let acknowledgementsOrphaned = 0;
    for (const { node } of await storage.acknowledgements(now)) {
      if (configured.has(node)) continue;
      if (await storage.unacknowledge(node)) acknowledgementsOrphaned += 1;
    }

    const report = {
      metrics,
      acknowledgementsExpired,
      acknowledgementsOrphaned,
    };
    this.options.logger.info("pruned", { ...report });

    return report;
  }
}

function formatTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}
