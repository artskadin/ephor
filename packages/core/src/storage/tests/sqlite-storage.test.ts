import { beforeEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../sqlite-storage.js";

describe("SqliteStorage", () => {
  let storage: SqliteStorage;

  beforeEach(async () => {
    storage = new SqliteStorage(":memory:");

    await storage.migrate();
  });

  it("round-trips a point with all fields", async () => {
    await storage.write([
      { ts: 100, node: "a", metric: "cpu", value: 12.5 },
      { ts: 100, node: "a", metric: "ru.tcp", ok: false, meta: { failed: 3 } },
    ]);

    const points = await storage.query({ node: "a" });

    expect(points).toHaveLength(2);
    expect(points.find((p) => p.metric === "cpu")?.value).toBe(12.5);

    const reach = points.find((p) => p.metric === "ru.tcp");
    expect(reach?.ok).toBe(false);
    expect(reach?.meta).toEqual({ failed: 3 });
  });

  it("latest returns only the newest value per metric", async () => {
    await storage.write([
      { ts: 100, node: "a", metric: "cpu", value: 10 },
      { ts: 200, node: "a", metric: "cpu", value: 20 },
      { ts: 150, node: "b", metric: "cpu", value: 30 },
    ]);

    const latest = await storage.latest();

    expect(latest).toHaveLength(2);
    expect(latest.find((p) => p.node === "a")?.value).toBe(20);
  });

  it("distinguishes ok: false from a missing value", async () => {
    await storage.write([{ ts: 100, node: "a", metric: "up", ok: false }]);

    const [point] = await storage.query({});

    expect(point?.ok).toBe(false);
    expect(point).not.toHaveProperty("value");
  });

  it("prune removes only older rows", async () => {
    await storage.write([
      { ts: 100, node: "a", metric: "cpu", value: 1 },
      { ts: 500, node: "a", metric: "cpu", value: 2 },
    ]);

    const removed = await storage.prune(400);

    expect(removed).toBe(1);
    expect(await storage.query({})).toHaveLength(1);
  });
});
