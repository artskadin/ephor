import type { Clock } from "./clock";

// A tick is due every second; a longer silence means the process was not
// running: a laptop asleep, a stopped process, a blocked event loop.
const TICK_MS = 1000;
const GAP_MS = 5000;

interface WakeWatchOptions {
  clock: Clock;
  onWake?: ((gapMs: number) => void) | undefined;
}

/** When the collector last came back: its start, or a wake after a gap. */
export class WakeWatch {
  private timer?: NodeJS.Timeout | undefined;
  private lastTickMs: number;
  private awakeSinceMs: number;

  constructor(private readonly options: WakeWatchOptions) {
    this.lastTickMs = options.clock.now();
    this.awakeSinceMs = this.lastTickMs;
  }

  start(): void {
    if (this.timer) return;
    this.lastTickMs = this.options.clock.now();
    this.awakeSinceMs = this.lastTickMs;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): void {
    const now = this.options.clock.now();
    const gapMs = now - this.lastTickMs;
    this.lastTickMs = now;

    if (gapMs > GAP_MS) {
      this.awakeSinceMs = now;
      this.options.onWake?.(gapMs);
    }
  }

  /** Epoch milliseconds. */
  get awakeSince(): number {
    return this.awakeSinceMs;
  }
}
