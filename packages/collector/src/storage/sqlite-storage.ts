import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Logger, MetricPoint, QueryFilter, Storage } from "@ephorate/core";
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
  private readonly database: DatabaseSync;
  private readonly logger: Logger;

  constructor(path: string, logger: Logger = SILENT_LOGGER) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.database = new DatabaseSync(path);
    this.logger = logger;

    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
  }

  async migrate(): Promise<void> {
    applyMigrations(this.database, MIGRATIONS, this.logger);
  }

  async write(points: readonly MetricPoint[]): Promise<void> {
    if (points.length === 0) return;

    // A repeat replaces: a forced run can land in the same second as a
    // scheduled one.
    const insert = this.database.prepare(`
      INSERT INTO metrics (ts, node, metric, value, ok, meta)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (node, metric, ts) DO UPDATE SET
        value = excluded.value,
        ok    = excluded.ok,
        meta  = excluded.meta
    `);

    // The `ts` guard keeps a late retry from dragging the state backwards.
    const upsertLatest = this.database.prepare(`
      INSERT INTO metrics_latest (node, metric, ts, value, ok, meta)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (node, metric) DO UPDATE SET
        ts    = excluded.ts,
        value = excluded.value,
        ok    = excluded.ok,
        meta  = excluded.meta
      WHERE excluded.ts >= metrics_latest.ts
    `);

    this.database.exec("BEGIN");
    try {
      for (const point of points) {
        const value = point.value ?? null;
        const ok = point.ok === undefined ? null : point.ok ? 1 : 0;
        const meta = point.meta ? JSON.stringify(point.meta) : null;

        insert.run(point.ts, point.node, point.metric, value, ok, meta);
        upsertLatest.run(point.node, point.metric, point.ts, value, ok, meta);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
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

    // The tiebreaker is part of the contract: one run writes every metric
    // with the same ts, and a client pages by time window.
    const rows = this.database
      .prepare(
        `SELECT * FROM metrics ${where}
         ORDER BY ts DESC, node ASC, metric ASC ${limit}`,
      )
      .all(...params) as unknown as MetricRow[];

    return rows.map(rowToPoint);
  }

  async latest(node?: string): Promise<MetricPoint[]> {
    const params: string[] = [];
    const where = node !== undefined ? "WHERE node = ?" : "";
    if (node !== undefined) params.push(node);

    const rows = this.database
      .prepare(
        `SELECT ts, node, metric, value, ok, meta FROM metrics_latest ${where}`,
      )
      .all(...params) as unknown as MetricRow[];

    return rows.map(rowToPoint);
  }

  /** History only: `metrics_latest` keeps a silent node's last value, aged. */
  async prune(olderThanTs: number): Promise<number> {
    const result = this.database
      .prepare("DELETE FROM metrics WHERE ts < ?")
      .run(olderThanTs);

    return Number(result.changes);
  }

  async close(): Promise<void> {
    this.database.close();
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
