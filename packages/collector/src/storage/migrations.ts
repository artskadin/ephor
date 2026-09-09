import type { DatabaseSync } from "node:sqlite";
import { createLogger, type Logger } from "@ephorate/core";

export interface Migration {
  /** Starting at 1; never reused, never reordered. */
  version: number;
  name: string;
  /** A migration touching rows says what it did to them. */
  apply(database: DatabaseSync, logger: Logger): void;
}

// Existing entries are frozen: databases in the wild have run them.
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "metrics",
    apply(database) {
      // `IF NOT EXISTS` adopts databases created before migrations existed.
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
      // A forced run in the same second as a scheduled one could leave two
      // rows; collapsed before the unique index refuses to build.
      const collapsed = database
        .prepare(
          `DELETE FROM metrics
           WHERE rowid NOT IN (
             SELECT MAX(rowid) FROM metrics GROUP BY node, metric, ts
           )`,
        )
        .run();

      if (Number(collapsed.changes) > 0) {
        logger.warn("collapsed points duplicated for the same instant", {
          removed: Number(collapsed.changes),
        });
      }

      // Replaced, not added: one B-tree serves both the upsert and
      // "newest first".
      database.exec("DROP INDEX IF EXISTS idx_metrics_lookup");
      database.exec(`
        CREATE UNIQUE INDEX idx_metrics_lookup
        ON metrics (node, metric, ts DESC)
      `);

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

/** An explicit level never parses `EPHOR_LOG_LEVEL`; safe at import. */
export const SILENT_LOGGER: Logger = createLogger({ level: "silent" });

export class MigrationError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "MigrationError";
  }
}

/** One transaction per migration: a failure leaves the previous version. */
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
    throw new MigrationError(
      "could not read the schema version of the database; if another " +
        "collector is running against the same file, stop it first",
      { cause: error },
    );
  }
  const knownVersion = migrations.at(-1)?.version ?? 0;

  if (currentVersion > knownVersion) {
    throw new MigrationError(
      `database schema is at version ${currentVersion}, but this build knows ` +
        `only up to ${knownVersion}. Downgrading is not supported — run the ` +
        `version of ephor that created this database, or restore a backup.`,
    );
  }

  let appliedVersion = currentVersion;

  for (const migration of migrations) {
    if (migration.version <= appliedVersion) continue;

    // Announced before it starts: minutes of silence look like a hang.
    const migrationLogger = logger.child({
      migration: migration.version,
      name: migration.name,
    });
    migrationLogger.info("applying migration");
    const startedAt = performance.now();

    try {
      // IMMEDIATE takes the write lock at once, so two collectors on one
      // file cannot both run the migration; inside the try, so losing the
      // lock is reported as this migration failing.
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

// SQLite rolls back by itself on a full disk, and `ROLLBACK` then complains;
// that complaint must not replace the error that matters.
function rollbackQuietly(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Already rolled back.
  }
}

function readCurrentVersion(database: DatabaseSync): number {
  const row = database
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null } | undefined;

  return row?.version ?? 0;
}

/** A gap or a duplicate is two branches picking one number: a bug. */
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
