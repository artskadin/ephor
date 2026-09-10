import type { StateResponse } from "@ephorate/core";

/** What `watch` needs of `ApiClient`; a test stands in a fake. */
export interface WatchSource {
  apiUrl: string;
  state(): Promise<StateResponse>;
}

interface Outage {
  sinceMs: number;
  message: string;
}

interface WatchSnapshot {
  state: StateResponse;
  /** Epoch milliseconds of the last successful poll. */
  updatedMs: number;
  outage: Outage | undefined;
}

interface WatchStoreOptions {
  source: WatchSource;
  /** Fetched before the first frame: a failure there is the command's. */
  initial: StateResponse;
  intervalMs: number;
  /** Epoch milliseconds. */
  now: () => number;
}

/**
 * The polling loop, outside React: the view is remounted on every window
 * resize, and the last table and the outage must survive that. A poll
 * that fails keeps the last state and records since when.
 */
export class WatchStore {
  private snapshot: WatchSnapshot;
  private readonly listeners = new Set<() => void>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly options: WatchStoreOptions) {
    this.snapshot = {
      state: options.initial,
      updatedMs: options.now(),
      outage: undefined,
    };
  }

  /** The same object until something changes: `useSyncExternalStore`. */
  read = (): WatchSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return () => void this.listeners.delete(listener);
  };

  start(): void {
    this.timer = setTimeout(() => void this.poll(), this.options.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private async poll(): Promise<void> {
    const { source, now, intervalMs } = this.options;

    try {
      const state = await source.state();
      if (this.stopped) return;

      this.publish({ state, updatedMs: now(), outage: undefined });
    } catch (error) {
      if (this.stopped) return;

      // Dated from the first failure; later ones change nothing.
      if (this.snapshot.outage === undefined) {
        this.publish({
          ...this.snapshot,
          outage: {
            sinceMs: now(),
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    this.timer = setTimeout(() => void this.poll(), intervalMs);
  }

  private publish(snapshot: WatchSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
