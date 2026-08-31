import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLogger, type Logger } from "@ephor/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, MIGRATIONS, type Migration } from "../migrations.js";

interface CapturedLog {
  logger: Logger;
  lines: Record<string, unknown>[];
}

const capturingLogger = (): CapturedLog => {
  const lines: Record<string, unknown>[] = [];

  return {
    lines,
    logger: createLogger({
      level: "debug",
      format: "json",
      write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
  };
};

describe("applyMigrations", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
  });

  const appliedVersions = (): number[] =>
    (
      database
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as unknown as { version: number }[]
    ).map((row) => row.version);

  const tableNames = (): string[] =>
    (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as unknown as { name: string }[]
    ).map((row) => row.name);

  it("applies every migration in order and records it", () => {
    const order: string[] = [];
    applyMigrations(database, [
      {
        version: 1,
        name: "first",
        apply: (db) => {
          order.push("first");
          db.exec("CREATE TABLE first (x INTEGER)");
        },
      },
      {
        version: 2,
        name: "second",
        apply: (db) => {
          order.push("second");
          db.exec("CREATE TABLE second (x INTEGER)");
        },
      },
    ]);

    expect(order).toEqual(["first", "second"]);
    expect(appliedVersions()).toEqual([1, 2]);
    expect(tableNames()).toContain("first");
    expect(tableNames()).toContain("second");
  });

  it("stamps each applied migration with a name and a time", () => {
    const before = Math.floor(Date.now() / 1000);

    applyMigrations(database, [
      { version: 1, name: "metrics", apply: () => {} },
    ]);

    const row = database
      .prepare("SELECT name, applied_at FROM schema_migrations")
      .get() as { name: string; applied_at: number };

    expect(row.name).toBe("metrics");
    expect(row.applied_at).toBeGreaterThanOrEqual(before);
  });

  // Migration 2 takes ten seconds on a three-million-row database, and it
  // runs before the collector logs anything else. Without these lines the
  // operator cannot tell a long upgrade from a hung process.
  describe("reporting progress", () => {
    it("says which migration starts and how long it took", () => {
      const { logger, lines } = capturingLogger();

      applyMigrations(
        database,
        [{ version: 1, name: "metrics", apply: () => {} }],
        logger,
      );

      expect(lines.map((line) => line.msg)).toEqual([
        "applying migration",
        "migration applied",
      ]);
      expect(lines[0]).toMatchObject({ migration: 1, name: "metrics" });
      expect(lines[1]?.durationMs).toEqual(expect.any(Number));
    });

    it("stays quiet when there is nothing to apply", () => {
      const migrations: Migration[] = [
        { version: 1, name: "metrics", apply: () => {} },
      ];
      applyMigrations(database, migrations);

      const { logger, lines } = capturingLogger();
      applyMigrations(database, migrations, logger);

      expect(lines).toEqual([]);
    });
  });

  it("does not run a migration twice", () => {
    let runs = 0;
    const migrations: Migration[] = [
      {
        version: 1,
        name: "first",
        apply: () => {
          runs++;
        },
      },
    ];

    applyMigrations(database, migrations);
    applyMigrations(database, migrations);

    expect(runs).toBe(1);
    expect(appliedVersions()).toEqual([1]);
  });

  it("applies only what is missing when the database is behind", () => {
    const first: Migration = {
      version: 1,
      name: "first",
      apply: (db) => db.exec("CREATE TABLE first (x INTEGER)"),
    };
    applyMigrations(database, [first]);

    let secondRuns = 0;
    applyMigrations(database, [
      first,
      {
        version: 2,
        name: "second",
        apply: (db) => {
          secondRuns++;
          db.exec("CREATE TABLE second (x INTEGER)");
        },
      },
    ]);

    expect(secondRuns).toBe(1);
    expect(appliedVersions()).toEqual([1, 2]);
  });

  it("refuses a database written by a newer build", () => {
    applyMigrations(database, [
      { version: 1, name: "first", apply: () => {} },
      { version: 2, name: "second", apply: () => {} },
    ]);

    expect(() =>
      applyMigrations(database, [
        { version: 1, name: "first", apply: () => {} },
      ]),
    ).toThrowError(/version 2.*only up to 1/s);
  });

  describe("a failing migration", () => {
    const failing: readonly Migration[] = [
      {
        version: 1,
        name: "first",
        apply: (db) => db.exec("CREATE TABLE first (x INTEGER)"),
      },
      {
        version: 2,
        name: "half-done",
        apply: (db) => {
          db.exec("CREATE TABLE second (x INTEGER)");
          db.exec("THIS IS NOT SQL");
        },
      },
    ];

    it("leaves nothing of itself behind", () => {
      expect(() => applyMigrations(database, failing)).toThrow();

      // The table created before the failure must be gone: a half-applied
      // schema would pass the version check on the next start and then break
      // somewhere far from here.
      expect(tableNames()).toContain("first");
      expect(tableNames()).not.toContain("second");
    });

    it("leaves the recorded version at the last one that succeeded", () => {
      expect(() => applyMigrations(database, failing)).toThrow();

      expect(appliedVersions()).toEqual([1]);
    });

    // The number in this message is what an operator acts on: it tells them
    // which build can still read the database. Reporting the version the run
    // started from would send someone with a half-upgraded database back to
    // a build that cannot open it.
    it("reports the version the database is actually left at", () => {
      let caught: unknown;
      try {
        applyMigrations(database, [
          {
            version: 1,
            name: "one",
            apply: (db) => db.exec("CREATE TABLE one (x INTEGER)"),
          },
          {
            version: 2,
            name: "two",
            apply: (db) => db.exec("CREATE TABLE two (x INTEGER)"),
          },
          {
            version: 3,
            name: "three",
            apply: () => {
              throw new Error("boom");
            },
          },
        ]);
      } catch (error) {
        caught = error;
      }

      expect(appliedVersions()).toEqual([1, 2]);
      expect((caught as Error).message).toContain("left at version 2");
    });

    it("names the migration and keeps the original error as the cause", () => {
      let caught: unknown;
      try {
        applyMigrations(database, failing);
      } catch (error) {
        caught = error;
      }

      expect((caught as Error).message).toContain("half-done");
      expect((caught as Error).cause).toBeInstanceOf(Error);
      expect(((caught as Error).cause as Error).message).toMatch(
        /syntax error/,
      );
    });

    // SQLite rolls the transaction back by itself for a full disk or an I/O
    // error, and `ROLLBACK` then fails. A migration that rolls back before
    // throwing reproduces that state without needing to fill a disk.
    it("keeps the real error when the transaction is already gone", () => {
      let caught: unknown;
      try {
        applyMigrations(database, [
          {
            version: 1,
            name: "self-rolling-back",
            apply: (db) => {
              db.exec("ROLLBACK");
              throw new Error("disk full");
            },
          },
        ]);
      } catch (error) {
        caught = error;
      }

      expect((caught as Error).message).toContain("self-rolling-back");
      expect(((caught as Error).cause as Error).message).toBe("disk full");
    });

    it("can be retried once the migration is fixed", () => {
      expect(() => applyMigrations(database, failing)).toThrow();

      applyMigrations(database, [
        failing[0] as Migration,
        {
          version: 2,
          name: "fixed",
          apply: (db) => db.exec("CREATE TABLE second (x INTEGER)"),
        },
      ]);

      expect(appliedVersions()).toEqual([1, 2]);
      expect(tableNames()).toContain("second");
    });
  });

  describe("a malformed migration list", () => {
    it("rejects a duplicated version", () => {
      expect(() =>
        applyMigrations(database, [
          { version: 1, name: "first", apply: () => {} },
          { version: 1, name: "also first", apply: () => {} },
        ]),
      ).toThrowError(/expected version 2/);
    });

    it("rejects a gap", () => {
      expect(() =>
        applyMigrations(database, [
          { version: 1, name: "first", apply: () => {} },
          { version: 3, name: "third", apply: () => {} },
        ]),
      ).toThrowError(/expected version 2/);
    });

    it("rejects a list that does not start at 1", () => {
      expect(() =>
        applyMigrations(database, [
          { version: 2, name: "second", apply: () => {} },
        ]),
      ).toThrowError(/expected version 1/);
    });

    it("does not apply anything before failing", () => {
      expect(() =>
        applyMigrations(database, [
          {
            version: 2,
            name: "second",
            apply: (db) => db.exec("CREATE TABLE second (x INTEGER)"),
          },
        ]),
      ).toThrow();

      expect(tableNames()).not.toContain("second");
    });
  });
});

// Two collectors started against the same file is a mistake a user can make
// in a second. Whoever loses the write lock must fail loudly instead of
// running the same migration a second time.
describe("applyMigrations with a second connection holding the lock", () => {
  let directory: string;
  let holder: DatabaseSync;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ephor-migrations-"));
    path = join(directory, "metrics.db");
    holder = new DatabaseSync(path);
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("CREATE TABLE placeholder (x INTEGER)");
  });

  afterEach(() => {
    holder.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("fails as a migration error rather than a bare lock complaint", () => {
    const database = new DatabaseSync(path);

    let caught: unknown;
    try {
      applyMigrations(database);
    } catch (error) {
      caught = error;
    }
    database.close();

    expect((caught as Error).name).toBe("MigrationError");
    expect((caught as Error).message).toMatch(/another collector/);
    expect(((caught as Error).cause as Error).message).toMatch(/lock/i);
  });
});

describe("the shipped migrations", () => {
  it("bring an empty database to the schema the collector expects", () => {
    const database = new DatabaseSync(":memory:");

    applyMigrations(database);

    const objects = (
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
        )
        .all() as unknown as { name: string }[]
    ).map((row) => row.name);

    expect(objects).toContain("metrics");
    expect(objects).toContain("metrics_latest");
    expect(objects).toContain("idx_metrics_lookup");
    expect(objects).toContain("idx_metrics_ts");
  });

  // The point of replacing the index rather than adding one: two B-trees
  // over the same three columns would be paid for on every single insert.
  it("leave one index over (node, metric, ts), and it is unique", () => {
    const database = new DatabaseSync(":memory:");

    applyMigrations(database);

    const indexes = database
      .prepare("PRAGMA index_list(metrics)")
      .all() as unknown as { name: string; unique: number }[];
    const lookup = indexes.filter(
      (index) => index.name === "idx_metrics_lookup",
    );

    expect(lookup).toHaveLength(1);
    expect(lookup[0]?.unique).toBe(1);
  });

  // Databases created before migrations existed have the tables but no
  // record of any version. They must adopt the numbering without losing a
  // row — this is the only upgrade path that already has real data behind it.
  it("adopt a database created before migrations existed", () => {
    const database = new DatabaseSync(":memory:");
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
      CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics (ts)
    `);
    database
      .prepare("INSERT INTO metrics (ts, node, metric, value) VALUES (?,?,?,?)")
      .run(100, "frankfurt-01", "system.load_percent", 12.5);

    applyMigrations(database);

    const rows = database.prepare("SELECT value FROM metrics").all();
    expect(rows).toEqual([{ value: 12.5 }]);
    expect(
      database.prepare("SELECT MAX(version) AS v FROM schema_migrations").get(),
    ).toEqual({ v: MIGRATIONS.length });
  });

  describe("upgrading a version 1 database that already holds history", () => {
    const atVersionOne = (): DatabaseSync => {
      const database = new DatabaseSync(":memory:");
      applyMigrations(database, MIGRATIONS.slice(0, 1));
      return database;
    };

    const insert = (
      database: DatabaseSync,
      ts: number,
      node: string,
      metric: string,
      value: number,
    ): void => {
      database
        .prepare(
          "INSERT INTO metrics (ts, node, metric, value) VALUES (?,?,?,?)",
        )
        .run(ts, node, metric, value);
    };

    it("fills metrics_latest from the history that is already there", () => {
      const database = atVersionOne();
      insert(database, 100, "a", "cpu", 1);
      insert(database, 300, "a", "cpu", 3);
      insert(database, 200, "a", "cpu", 2);
      insert(database, 150, "b", "cpu", 9);

      applyMigrations(database);

      expect(
        database
          .prepare("SELECT node, ts, value FROM metrics_latest ORDER BY node")
          .all(),
      ).toEqual([
        { node: "a", ts: 300, value: 3 },
        { node: "b", ts: 150, value: 9 },
      ]);
    });

    // Without this the unique index cannot be built, and a migration that
    // throws leaves the collector unable to start at all.
    it("collapses points duplicated for the same instant", () => {
      const database = atVersionOne();
      insert(database, 100, "a", "cpu", 1);
      insert(database, 100, "a", "cpu", 2);

      applyMigrations(database);

      // The later write is the one kept: it is the more recent measurement.
      expect(database.prepare("SELECT ts, value FROM metrics").all()).toEqual([
        { ts: 100, value: 2 },
      ]);
    });

    it("says how many duplicates it removed, and only when it removed any", () => {
      const withDuplicates = atVersionOne();
      insert(withDuplicates, 100, "a", "cpu", 1);
      insert(withDuplicates, 100, "a", "cpu", 2);
      const noisy = capturingLogger();

      applyMigrations(withDuplicates, MIGRATIONS, noisy.logger);

      expect(noisy.lines.find((line) => line.level === "warn")).toMatchObject({
        msg: "collapsed points duplicated for the same instant",
        removed: 1,
      });

      const clean = atVersionOne();
      insert(clean, 100, "a", "cpu", 1);
      const quiet = capturingLogger();

      applyMigrations(clean, MIGRATIONS, quiet.logger);

      expect(quiet.lines.some((line) => line.level === "warn")).toBe(false);
    });
  });
});
