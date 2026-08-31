import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MetricPoint, QueryFilter, Storage } from "@ephor/core";
import { applyMigrations } from "./migrations.js";

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

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);

    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
  }

  async migrate(): Promise<void> {
    applyMigrations(this.db);
  }

  async write(points: readonly MetricPoint[]): Promise<void> {
    if (points.length === 0) return;

    const insert = this.db.prepare(`
      INSERT INTO metrics (ts, node, metric, value, ok, meta)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.db.exec("BEGIN");
    try {
      for (const point of points) {
        insert.run(
          point.ts,
          point.node,
          point.metric,
          point.value ?? null,
          point.ok === undefined ? null : point.ok ? 1 : 0,
          point.meta ? JSON.stringify(point.meta) : null,
        );
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
        `
        SELECT ts, node, metric, value, ok, meta FROM (
          SELECT *,
                 ROW_NUMBER() OVER (
                   PARTITION BY node, metric ORDER BY ts DESC
                 ) AS rn
          FROM metrics
          ${where}
        )
        WHERE rn = 1
      `,
      )
      .all(...params) as unknown as MetricRow[];

    return rows.map(rowToPoint);
  }

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
