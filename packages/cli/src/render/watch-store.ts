import type { StateResponse } from "@ephorate/core";
import type { Notify } from "../notify/desktop-notifier";
import {
  describeTransition,
  isWorthNotifying,
  type NotifyLevel,
  SUMMARY_FROM,
  summarizeTransitions,
  transitionsBetween,
} from "../notify/transitions";
import { clock } from "./clock";

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
  /** Why desktop notifications stopped, after the first one that failed. */
  notificationsFailed: string | undefined;
}

interface WatchStoreOptions {
  source: WatchSource;
  /** Fetched before the first frame: a failure there is the command's. */
  initial: StateResponse;
  intervalMs: number;
  /** Epoch milliseconds. */
  now: () => number;
  /** A desktop notification per node whose status changed; off if unset. */
  notify?: Notify | undefined;
  /** Which changes notify; the collector going and coming back always do. */
  notifyOn?: NotifyLevel | undefined;
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
      notificationsFailed: undefined,
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

      const previous = this.snapshot.state;
      const outage = this.snapshot.outage;
      this.publish({
        ...this.snapshot,
        state,
        updatedMs: now(),
        outage: undefined,
      });

      const messages = transitionMessages(
        previous,
        state,
        this.options.notifyOn ?? "warn",
      );
      if (outage !== undefined) {
        messages.unshift({
          title: "ephor: collector back",
          body: `${source.apiUrl} answers again, silent since ${clock(outage.sinceMs)}`,
        });
      }
      void this.announce(messages);
    } catch (error) {
      if (this.stopped) return;

      // Dated from the first failure; later ones change nothing. Without
      // answers no node can turn stale here, so the loss is its own news.
      if (this.snapshot.outage === undefined) {
        const message = error instanceof Error ? error.message : String(error);
        this.publish({
          ...this.snapshot,
          outage: { sinceMs: now(), message },
        });
        void this.announce([
          { title: "ephor: collector unreachable", body: firstLine(message) },
        ]);
      }
    }

    this.timer = setTimeout(() => void this.poll(), intervalMs);
  }

  // One at a time, and the first failure switches notifications off: a
  // missing `notify-send` must not fail once per node, and the footer
  // says why once.
  private async announce(messages: readonly Message[]): Promise<void> {
    const { notify } = this.options;
    if (notify === undefined) return;

    for (const { title, body } of messages) {
      if (this.stopped || this.snapshot.notificationsFailed !== undefined) {
        return;
      }

      try {
        await notify(title, body);
      } catch (error) {
        if (this.stopped) return;

        this.publish({
          ...this.snapshot,
          notificationsFailed: firstLine(error),
        });
      }
    }
  }

  private publish(snapshot: WatchSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

/** `execFile` echoes the whole command and stderr; the footer has a line. */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return (message.split("\n")[0] ?? message).slice(0, 80);
}

interface Message {
  title: string;
  body: string;
}

// A burst (200 nodes after a restart) is one summary, counted after the
// level's filter: forty nodes into warn under `critical` say nothing.
function transitionMessages(
  previous: StateResponse,
  next: StateResponse,
  level: NotifyLevel,
): Message[] {
  const transitions = transitionsBetween(previous, next).filter((transition) =>
    isWorthNotifying(transition, level),
  );

  return transitions.length >= SUMMARY_FROM
    ? [summarizeTransitions(transitions)]
    : transitions.map(describeTransition);
}
