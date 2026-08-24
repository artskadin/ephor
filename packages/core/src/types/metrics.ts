export interface MetricPoint {
  /** unix-time in seconds */
  ts: number;
  /** node's name from config */
  node: string;
  /** metric's id: 'cpu', 'ru.tcp', 'speed.tele2' */
  metric: string;
  /** metric's value if metric is numerable */
  value?: number;
  /** result of metric if metric is boolean */
  ok?: boolean;
  /** additional metric metadata */
  meta?: Record<string, unknown>;
}
