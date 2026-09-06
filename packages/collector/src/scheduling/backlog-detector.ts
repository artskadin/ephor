import type { Logger, QueueState } from "@ephor/core";

export interface BacklogDetectorOptions {
  /** What the line names: `system`, `ssh through the jump host "bastion"`. */
  subject: string;
  logger: Logger;
}

/**
 * Says in the log when a queue is falling behind, and when it caught up —
 * once each, not once per task. The scheduler never has a pair in flight
 * twice at once, so a queue cannot grow past the number of pairs; what it
 * can do is hold measurements back until they are stale, silently. This is
 * the line that names the cause.
 *
 * Behind is a whole wave waiting, `queued >= limit`: the newest task in
 * line waits at least one full run before it starts. Not `queued > 0` —
 * simulated on the scheduler's own jitter for 200 nodes at a reachability
 * limit of 4 (the shipped one is 50), someone is waiting about a fifth of
 * the time and a whole wave a few percent, the exact share depending on
 * the node names; the lower bar would flap. Caught up is the queue empty,
 * so a queue hovering at the bar does not flap either. Under the default
 * limits the regular schedule never gets here; a fleet forced at once and
 * a slow ssh behind a shared sshd do.
 */
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
