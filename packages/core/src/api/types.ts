import type { NodeState } from "../state/node-state.js";

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

/**
 * One shape for every failure, so a client has one thing to parse. The
 * message is for a person; the HTTP status is what code should branch on.
 */
export interface ErrorResponse {
  error: string;
}
