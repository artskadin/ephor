export interface MetricPoint {
  /** Unix seconds. */
  ts: number;
  node: string;
  /** `<probe>.<name>`: `system.disk_percent`, `reachability.ru.tcp`. */
  metric: string;
  value?: number;
  ok?: boolean;
  meta?: Record<string, unknown>;
}
