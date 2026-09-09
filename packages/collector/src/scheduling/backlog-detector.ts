import type { Logger, QueueState } from "@ephorate/core";

interface BacklogDetectorOptions {
  /** What the line names: `system`, `ssh through the jump host "bastion"`. */
  subject: string;
  logger: Logger;
}

// Behind is a whole wave waiting, `queued >= limit`: at `queued > 0` the
// line would flap (simulated for 200 nodes at a limit of 4, someone waits
// a fifth of the time). Caught up is the queue empty. One line each way.
export class BacklogDetector {
  private behind = false;
  private peak = 0;

  constructor(private readonly options: BacklogDetectorOptions) {}

  observe(queue: QueueState): void {
    if (this.behind) {
      this.peak = Math.max(this.peak, queue.queued);

      if (queue.queued > 0) return;

      this.behind = false;
      this.options.logger.info(
        `${this.options.subject} caught up, peak was ${this.peak} queued`,
        { peak: this.peak, limit: queue.limit },
      );
      this.peak = 0;

      return;
    }

    if (queue.queued < queue.limit) return;

    this.behind = true;
    this.peak = queue.queued;
    this.options.logger.warn(
      `${this.options.subject} is falling behind: ${queue.queued} queued, limit ${queue.limit}`,
      { active: queue.active, queued: queue.queued, limit: queue.limit },
    );
  }
}
