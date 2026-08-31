import type { DatabaseSync } from "node:sqlite";
import { createLogger, type Logger } from "@ephor/core";

export interface Migration {
  /** Position in the sequence, starting at 1. Never reused, never reordered. */
  version: number;
  /** Shown in errors and in the schema_migrations table. */
  name: string;
  /**
   * The logger is passed in rather than reached for so that a migration
   * touching existing rows can say what it did to them — data changed
   * during an upgrade must never happen in silence.
   */
  apply(database: DatabaseSync, logger: Logger): void;
}

/**
 * Every change to the schema is a new entry here. Existing entries are
 * frozen: a database in the wild has already run them, so editing one
 * changes nothing there while silently changing what a fresh database gets.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "metrics",
    apply(database) {
      // `IF NOT EXISTS` is load-bearing rather than decorative: databases
      // created before migrations existed already carry these objects, and
      // this is what lets them adopt the versioning without a special case.
      database.exec(`
        CREATE TABLE IF NOT EXISTS metrics (
          ts     INTEGER NOT NULL,
          node   TEXT    NOT NULL,
          metric TEXT    NOT NULL,
          value  REAL,
          ok     INTEGER,
          meta   TEXT
        )
      `);

      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_metrics_lookup
        ON metrics (node, metric, ts DESC)
      `);

      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_metrics_ts
        ON metrics (ts)
      `);
    },
  },
  {
    version: 2,
    name: "metrics-latest",
    apply(database, logger) {
      // Nothing enforced one point per (node, metric, ts) until now, so a
      // forced run landing in the same whole second as a scheduled one could
      // leave two rows. Collapse them before the unique index refuses to
      // build: a migration that fails here would keep the collector from
      // starting at all.
      const collapsed = database
        .prepare(
          `DELETE FROM metrics
           WHERE rowid NOT IN (
             SELECT MAX(rowid) FROM metrics GROUP BY node, metric, ts
           )`,
        )
        .run();

      // Deleting a user's rows is not something to do quietly, even when the
      // rows were redundant.
      if (Number(collapsed.changes) > 0) {
        logger.warn("collapsed points duplicated for the same instant", {
          removed: Number(collapsed.changes),
        });
      }

      // Replaced rather than added: a separate unique index would be a second
      // B-tree over the same three columns, paid for on every insert. The
      // DESC one serves both roles — the conflict target for an upsert and
      // the order for "newest first" without a temporary sort.
      database.exec("DROP INDEX IF EXISTS idx_metrics_lookup");
      database.exec(`
        CREATE UNIQUE INDEX idx_metrics_lookup
        ON metrics (node, metric, ts DESC)
      `);

      // One row per series, so its size follows the number of nodes rather
      // than the length of history: 2800 rows for 200 nodes, whether the
      // database holds a day or a year.
      database.exec(`
        CREATE TABLE metrics_latest (
          node   TEXT    NOT NULL,
          metric TEXT    NOT NULL,
          ts     INTEGER NOT NULL,
          value  REAL,
          ok     INTEGER,
          meta   TEXT,
          PRIMARY KEY (node, metric)
        )
      `);

      database.exec(`
        INSERT INTO metrics_latest (node, metric, ts, value, ok, meta)
        SELECT node, metric, ts, value, ok, meta FROM (
          SELECT *,
                 ROW_NUMBER() OVER (
                   PARTITION BY node, metric ORDER BY ts DESC
                 ) AS rn
          FROM metrics
        )
        WHERE rn = 1
      `);
    },
  },
];

/**
 * Stand-in for callers that have no logger to give — tests, mostly. Built
 * once rather than per call, and safe at module scope because an explicit
 * level means `EPHOR_LOG_LEVEL` is never parsed here: a bad value in the
 * environment must be reported by the entry point, not thrown during import.
 */
export const SILENT_LOGGER: Logger = createLogger({ level: "silent" });

export class MigrationError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "MigrationError";
  }
}

/**
 * Brings the database up to the last known version, applying the missing
 * migrations in order. Each runs in its own transaction, so a failure leaves
 * the database on the version it had rather than halfway into a new one.
 */
export function applyMigrations(
  database: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
  logger: Logger = SILENT_LOGGER,
): void {
  assertSequential(migrations);

  let currentVersion: number;
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT    NOT NULL,
        applied_at INTEGER NOT NULL
      )
    `);

    currentVersion = readCurrentVersion(database);
  } catch (error) {
    // The most likely cause by far is a second collector holding the write
    // lock on the same file, and that reads as "database is locked" with no
    // hint of what to do about it.
    throw new MigrationError(
      "could not read the schema version of the database; if another " +
        "collector is running against the same file, stop it first",
      { cause: error },
    );
  }
  const knownVersion = migrations.at(-1)?.version ?? 0;

  // A database from a newer build has a schema this code does not understand.
  // Reading it would be wrong quietly; writing to it would corrupt data that
  // the newer build still expects to be able to read.
  if (currentVersion > knownVersion) {
    throw new MigrationError(
      `database schema is at version ${currentVersion}, but this build knows ` +
        `only up to ${knownVersion}. Downgrading is not supported — run the ` +
        `version of ephor that created this database, or restore a backup.`,
    );
  }

  // Tracked separately from `currentVersion` so a failure halfway through a
  // run reports where the database actually stands, not where it started.
  let appliedVersion = currentVersion;

  for (const migration of migrations) {
    if (migration.version <= appliedVersion) continue;

    // Announced before it starts, not after. A migration that rewrites the
    // history table is measured in seconds on a personal database and in
    // minutes on a large fleet, and it runs before the collector prints
    // anything else — silence there is indistinguishable from a hang.
    const migrationLogger = logger.child({
      migration: migration.version,
      name: migration.name,
    });
    migrationLogger.info("applying migration");
    const startedAt = performance.now();

    try {
      // IMMEDIATE rather than plain BEGIN: a deferred transaction takes no
      // write lock until its first write, so two collectors started against
      // one file would both read the same version and both run the
      // migration. Inside the try, so that losing the lock is reported as
      // this migration failing rather than as a bare "database is locked".
      database.exec("BEGIN IMMEDIATE");
      migration.apply(database, migrationLogger);
      database
        .prepare(
          `INSERT INTO schema_migrations (version, name, applied_at)
           VALUES (?, ?, unixepoch())`,
        )
        .run(migration.version, migration.name);
      database.exec("COMMIT");
      appliedVersion = migration.version;

      migrationLogger.info("migration applied", {
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      rollbackQuietly(database);
      throw new MigrationError(
        `migration ${migration.version} (${migration.name}) failed; the ` +
          `database is left at version ${appliedVersion}`,
        { cause: error },
      );
    }
  }
}

/**
 * SQLite rolls the transaction back by itself for some failures — a full
 * disk and an I/O error among them — and `ROLLBACK` then complains that
 * there is no transaction. Letting that complaint escape would replace the
 * error that actually matters with a meaningless one.
 */
function rollbackQuietly(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Already rolled back; the caller's error is the one worth reporting.
  }
}

function readCurrentVersion(database: DatabaseSync): number {
  const row = database
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null } | undefined;

  return row?.version ?? 0;
}

/**
 * A gap or a duplicate means two branches picked the same number, and the
 * databases they touched are now inconsistent with each other. That is a bug
 * in the source, so it fails loudly at startup rather than on some user's
 * disk months later.
 */
function assertSequential(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new MigrationError(
        `migrations must be numbered 1..n in order: expected version ` +
          `${expected} at position ${index}, found ${migration.version} ` +
          `(${migration.name})`,
      );
    }
  });
}
