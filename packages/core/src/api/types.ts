import type { NodeState } from "../state/node-state.js";
import type { MetricPoint } from "../types/metrics.js";

// The wire shapes live in core so the collector that writes them and the
// client that reads them cannot drift apart.

export interface StateResponse {
  /** The collector's clock: ages on the client's would be off by the skew. */
  now: number;
  nodes: NodeState[];
}

/** How busy one limit is: a probe's concurrency, ssh processes, one sshd. */
export interface QueueState {
  active: number;
  queued: number;
  limit: number;
}

/** Ssh's own limits below the probes; a run waiting here keeps its slot. */
export interface SshQueues {
  processes: QueueState;
  /**
   * Per sshd: `jump:<host>:<port>`, `proxy:<command>`, `node:<host>:<port>`,
   * or `node:<target as configured>` while the route is unresolved.
   */
  logins: Record<string, QueueState>;
}

export interface HealthResponse {
  ok: boolean;
  uptimeSeconds: number;
  runningTasks: number;
  nodes: number;
  probes: string[];
  /** Raw counts, not a verdict: `ok` stays true while a queue is behind. */
  queues: Record<string, QueueState>;
  ssh: SshQueues;
}

export interface NodeResponse {
  now: number;
  node: NodeState;
}

/** The state after a forced run; blocks at most `CHECK_MAX_WAIT_SECONDS`. */
export interface CheckResponse extends StateResponse {
  /** Unix seconds before the run was forced: later values are this run's. */
  startedAt: number;
  /** Every forced pair finished before the cap; a failed probe counts. */
  complete: boolean;
  /** Forced pairs still running. Poll `/api/state`, never post again. */
  pending: string[];
}

export interface MetricsResponse {
  /** Newest first. */
  points: MetricPoint[];
  /**
   * More than `limit` points in the window. A page ends on a complete
   * instant, so the next one is `to = oldest.ts - 1`.
   */
  truncated: boolean;
  from: number;
  to: number;
  limit: number;
}

export interface ErrorResponse {
  error: string;
}
