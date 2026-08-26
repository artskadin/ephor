import type { MetricPoint } from "../types/metrics.js";

export interface QueryFilter {
  node?: string | undefined;
  metric?: string | undefined;
  from?: number | undefined;
  to?: number | undefined;
  limit?: number | undefined;
}

export interface Storage {
  migrate(): Promise<void>;
  write(points: readonly MetricPoint[]): Promise<void>;
  query(filter: QueryFilter): Promise<MetricPoint[]>;
  latest(node?: string): Promise<MetricPoint[]>;
  prune(olderThanTs: number): Promise<number>;
  close(): Promise<void>;
}
