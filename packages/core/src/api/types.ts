import type { NodeState } from "../state/node-state.js";
import type { MetricPoint } from "../types/metrics.js";

/**
 * The wire shapes, in `core` rather than beside the server, so the collector
 * that writes them and the client that reads them cannot drift apart. They
 * are also the contract that outlives the framework: swapping Fastify for
 * anything else must leave these untouched, or every client breaks.
 */

export interface StateResponse {
  /**
   * The collector's clock, not the client's.
   *
   * Ages are what the table shows, and a client computing them from its own
   * clock would be wrong by however much the two machines disagree — on a
   * laptop talking to a bastion through a tunnel, that is routine.
   */
  now: number;
  nodes: NodeState[];
}

export interface HealthResponse {
  ok: boolean;
  /** Seconds since the collector started, not since the machine booted. */
  uptimeSeconds: number;
  /** Probe runs in flight right now. */
  runningTasks: number;
  /** How many nodes are being watched, after disabled ones are dropped. */
  nodes: number;
  probes: string[];
}

export interface NodeResponse {
  now: number;
  node: NodeState;
}

/**
 * `POST /api/check`: the state after a forced run, and what became of the
 * run itself. The request blocks while the forced pairs run, for at most
 * `CHECK_MAX_WAIT_SECONDS`; the probes keep going after that.
 */
export interface CheckResponse extends StateResponse {
  /**
   * Unix seconds, taken before the run was forced. A value measured at or
   * after it belongs to this run; anything older is what was there before.
   */
  startedAt: number;
  /**
   * Every forced pair finished before the cap. A failed probe is finished
   * too — it wrote `<probe>.up: false` — so `complete` says the answer is
   * final, not that it is good.
   */
  complete: boolean;
  /**
   * Nodes among the forced pairs with a probe that has not written this
   * run's `.up` yet. A client waits for it to empty by polling `/api/state`
   * and comparing ages, never by posting again: another post is another run.
   */
  pending: string[];
}

export interface MetricsResponse {
  /** Newest first, as the storage returns them. */
  points: MetricPoint[];
  /**
   * True when the window held more than `limit` points and the rest were
   * left out. Never silent: truncated history that looks complete is worse
   * than the crash the limit exists to prevent.
   *
   * A truncated page ends on a complete instant — every point sharing the
   * oldest `ts` is present — so the next page is `to = oldest.ts - 1` with
   * nothing skipped and nothing repeated. Page by moving the window, never
   * by offset: offsets shift under a collector that never stops appending.
   */
  truncated: boolean;
  /** The window and limit actually applied, defaults filled in. */
  from: number;
  to: number;
  limit: number;
}

/**
 * One shape for every failure, so a client has one thing to parse. The
 * message is for a person; the HTTP status is what code should branch on.
 */
export interface ErrorResponse {
  error: string;
}
