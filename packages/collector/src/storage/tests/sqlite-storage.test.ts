import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../sqlite-storage.js";
import { describeStorageContract } from "./storage-contract.js";

describeStorageContract("SqliteStorage", () => new SqliteStorage(":memory:"));

describe("SqliteStorage on disk", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ephor-storage-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("creates the directories leading to the database file", async () => {
    const path = join(directory, "nested", "deeper", "metrics.db");

    const storage = new SqliteStorage(path);
    await storage.migrate();
    await storage.close();

    expect(existsSync(path)).toBe(true);
  });

  it("keeps the data across a reopen", async () => {
    const path = join(directory, "metrics.db");

    const first = new SqliteStorage(path);
    await first.migrate();
    await first.write([{ ts: 100, node: "a", metric: "cpu", value: 12.5 }]);
    await first.close();

    const second = new SqliteStorage(path);
    await second.migrate();
    const points = await second.query({});
    await second.close();

    expect(points.map((point) => point.value)).toEqual([12.5]);
  });

  // WAL is what lets the HTTP API read while the collector writes. Without
  // it a reader blocks on every write, which is invisible until the API is
  // added and then looks like the API being slow.
  it("runs in WAL mode", async () => {
    const path = join(directory, "metrics.db");

    const storage = new SqliteStorage(path);
    await storage.migrate();
    await storage.close();

    const database = new DatabaseSync(path);
    const mode = database.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    database.close();

    expect(mode.journal_mode).toBe("wal");
  });
});
