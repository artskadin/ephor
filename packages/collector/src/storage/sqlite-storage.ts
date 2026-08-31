import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Logger, MetricPoint, QueryFilter, Storage } from "@ephor/core";
import { applyMigrations, MIGRATIONS, SILENT_LOGGER } from "./migrations.js";

interface MetricRow {
  ts: number;
  node: string;
  metric: string;
  value: number | null;
  ok: number | null;
  meta: string | null;
}

export class SqliteStorage implements Storage {
  private readonly db: DatabaseSync;
  private readonly logger: Logger;

  constructor(path: string, logger: Logger = SILENT_LOGGER) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.logger = logger;

    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
  }

  async migrate(): Promise<void> {
    applyMigrations(this.db, MIGRATIONS, this.logger);
  }

  async write(points: readonly MetricPoint[]): Promise<void> {
    if (points.length === 0) return;

    // Writing the same point twice replaces it rather than failing: a forced
    // run can land in the same whole second as a scheduled one, and refusing
    // the second would turn `ephor check` into an error for no reason.
    const insert = this.db.prepare(`
      INSERT INTO metrics (ts, node, metric, value, ok, meta)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (node, metric, ts) DO UPDATE SET
        value = excluded.value,
        ok    = excluded.ok,
        meta  = excluded.meta
    `);

    // The guard on `ts` is what keeps a late write from dragging the current
    // state backwards — a retried probe finishing after a newer one must not
    // make the node look older than it is.
    const upsertLatest = this.db.prepare(`
      INSERT INTO metrics_latest (node, metric, ts, value, ok, meta)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (node, metric) DO UPDATE SET
        ts    = excluded.ts,
        value = excluded.value,
        ok    = excluded.ok,
        meta  = excluded.meta
      WHERE excluded.ts >= metrics_latest.ts
    `);

    this.db.exec("BEGIN");
    try {
      for (const point of points) {
        const value = point.value ?? null;
        const ok = point.ok === undefined ? null : point.ok ? 1 : 0;
        const meta = point.meta ? JSON.stringify(point.meta) : null;

        insert.run(point.ts, point.node, point.metric, value, ok, meta);
        // Same transaction as the history row: the two must never disagree
        // about what the last value was.
        upsertLatest.run(point.node, point.metric, point.ts, value, ok, meta);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async query(filter: QueryFilter): Promise<MetricPoint[]> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.node !== undefined) {
      conditions.push("node = ?");
      params.push(filter.node);
    }

    if (filter.metric !== undefined) {
      conditions.push("metric = ?");
      params.push(filter.metric);
    }

    if (filter.from !== undefined) {
      conditions.push("ts >= ?");
      params.push(filter.from);
    }

    if (filter.to !== undefined) {
      conditions.push("ts <= ?");
      params.push(filter.to);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter.limit !== undefined ? "LIMIT ?" : "";
    if (filter.limit !== undefined) params.push(filter.limit);

    const rows = this.db
      .prepare(`SELECT * FROM metrics ${where} ORDER BY ts DESC ${limit}`)
      .all(...params) as unknown as MetricRow[];

    return rows.map(rowToPoint);
  }

  async latest(node?: string): Promise<MetricPoint[]> {
    const params: string[] = [];
    const where = node !== undefined ? "WHERE node = ?" : "";
    if (node !== undefined) params.push(node);

    const rows = this.db
      .prepare(
        `SELECT ts, node, metric, value, ok, meta FROM metrics_latest ${where}`,
      )
      .all(...params) as unknown as MetricRow[];

    return rows.map(rowToPoint);
  }

  /**
   * History only. `metrics_latest` is deliberately left alone: a node that
   * stopped reporting must keep its last known value, with its real age, so
   * the client can call it stale. Dropping the row instead would make the
   * node disappear from `ephor status`, which reads as "not configured"
   * rather than "not answering".
   */
  async prune(olderThanTs: number): Promise<number> {
    const result = this.db
      .prepare("DELETE FROM metrics WHERE ts < ?")
      .run(olderThanTs);

    return Number(result.changes);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

function rowToPoint(row: MetricRow): MetricPoint {
  const point: MetricPoint = {
    ts: row.ts,
    node: row.node,
    metric: row.metric,
  };

  if (row.value !== null) point.value = row.value;
  if (row.ok !== null) point.ok = row.ok === 1;
  if (row.meta !== null) {
    point.meta = JSON.parse(row.meta) as Record<string, unknown>;
  }

  return point;
}
