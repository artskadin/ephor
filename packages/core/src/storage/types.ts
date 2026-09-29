import type { MetricStatus } from "../state/node-state";
import type { MetricPoint } from "../types/metrics";

export interface QueryFilter {
  node?: string | undefined;
  metric?: string | undefined;
  from?: number | undefined;
  to?: number | undefined;
  limit?: number | undefined;
}

/** A node's problem, known and owned: notifications keep quiet about it. */
export interface Acknowledgement {
  node: string;
  note?: string | undefined;
  /** Unix seconds. */
  since: number;
  /** Unix seconds: gone at this moment, whatever the node does. */
  until?: number | undefined;
  /** What was acknowledged: the node's status at `since`. */
  status: MetricStatus;
  /**
   * Nagios's two kinds: `false` lasts while the node keeps `status`, any
   * change is news again; `true` ("sticky") lasts until the node is ok.
   */
  untilOk: boolean;
}

export interface Storage {
  migrate(): Promise<void>;
  write(points: readonly MetricPoint[]): Promise<void>;
  query(filter: QueryFilter): Promise<MetricPoint[]>;
  latest(node?: string): Promise<MetricPoint[]>;
  prune(olderThanTs: number): Promise<number>;
  /** One per node: a second replaces the first. */
  acknowledge(acknowledgement: Acknowledgement): Promise<void>;
  /** Whether there was one to remove. */
  unacknowledge(node: string): Promise<boolean>;
  /** In force at `now`, unix seconds: no `until`, or a later one. By node. */
  acknowledgements(now: number): Promise<Acknowledgement[]>;
  /** Removes those whose `until` has passed at `now`; how many. */
  expireAcknowledgements(now: number): Promise<number>;
  close(): Promise<void>;
}
