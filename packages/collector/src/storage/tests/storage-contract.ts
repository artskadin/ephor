import type { MetricPoint, Storage } from "@ephor/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * What every `Storage` implementation must do, regardless of the database
 * behind it. `implements Storage` only promises method signatures; this is
 * where the behaviour is pinned down, so a second driver either passes the
 * same suite or is not finished.
 *
 * The factory hands back an *unmigrated* storage — running `migrate()` first
 * is part of the contract, not a detail of the caller.
 *
 * Not a `.test.ts` file on purpose: vitest collects those by name, and an
 * exporting-only module would be reported as a suite with no tests.
 */
export function describeStorageContract(
  name: string,
  createStorage: () => Storage,
): void {
  describe(`${name} — storage contract`, () => {
    let storage: Storage;

    beforeEach(async () => {
      storage = createStorage();
      await storage.migrate();
    });

    afterEach(async () => {
      await storage.close();
    });

    describe("migrate", () => {
      it("can be run again on an already migrated database", async () => {
        await storage.write([{ ts: 100, node: "a", metric: "cpu", value: 1 }]);

        await storage.migrate();

        expect(await storage.query({})).toHaveLength(1);
      });
    });

    describe("write and query", () => {
      it("round-trips every field of a point", async () => {
        const record: MetricPoint = {
          ts: 1_700_000_000,
          node: "frankfurt-01",
          metric: "system.ports",
          value: 3,
          ok: true,
          meta: { listening: [22, 443], unexpected: [], note: "text" },
        };

        await storage.write([record]);

        const [point] = await storage.query({});

        expect(point).toEqual(record);
      });

      // Asserting the round trip against the very object that was written
      // cannot tell a stored copy from the same reference handed back. A
      // driver that keeps points in memory would pass that assertion while
      // letting a caller mutate what is already "stored".
      it("stores a copy, not a reference to the caller's object", async () => {
        const record: MetricPoint = {
          ts: 100,
          node: "a",
          metric: "system.ports",
          value: 1,
          meta: { listening: [22] },
        };

        await storage.write([record]);
        record.value = 999;
        (record.meta as { listening: number[] }).listening.push(443);

        const [point] = await storage.query({});

        expect(point?.value).toBe(1);
        expect(point?.meta).toEqual({ listening: [22] });
      });

      it("keeps an absent optional field absent rather than null", async () => {
        await storage.write([{ ts: 100, node: "a", metric: "system.up" }]);

        const [point] = await storage.query({});

        expect(point).not.toHaveProperty("value");
        expect(point).not.toHaveProperty("ok");
        expect(point).not.toHaveProperty("meta");
      });

      it("distinguishes ok: false from a missing value", async () => {
        await storage.write([{ ts: 100, node: "a", metric: "up", ok: false }]);

        const [point] = await storage.query({});

        expect(point?.ok).toBe(false);
        expect(point).not.toHaveProperty("value");
      });

      it("stores a zero value rather than treating it as absent", async () => {
        await storage.write([
          { ts: 100, node: "a", metric: "system.load_percent", value: 0 },
        ]);

        expect((await storage.query({}))[0]?.value).toBe(0);
      });

      it("accepts an empty batch without touching the data", async () => {
        await storage.write([{ ts: 100, node: "a", metric: "cpu", value: 1 }]);

        await storage.write([]);

        expect(await storage.query({})).toHaveLength(1);
      });

      it("keeps points that differ only by node or metric apart", async () => {
        await storage.write([
          { ts: 100, node: "a", metric: "cpu", value: 1 },
          { ts: 100, node: "b", metric: "cpu", value: 2 },
          { ts: 100, node: "a", metric: "mem", value: 3 },
        ]);

        expect(await storage.query({})).toHaveLength(3);
      });

      it("filters by node", async () => {
        await storage.write([
          { ts: 100, node: "a", metric: "cpu", value: 1 },
          { ts: 100, node: "b", metric: "cpu", value: 2 },
        ]);

        const points = await storage.query({ node: "b" });

        expect(points.map((point) => point.value)).toEqual([2]);
      });

      it("filters by metric", async () => {
        await storage.write([
          { ts: 100, node: "a", metric: "cpu", value: 1 },
          { ts: 100, node: "a", metric: "mem", value: 2 },
        ]);

        const points = await storage.query({ metric: "mem" });

        expect(points.map((point) => point.value)).toEqual([2]);
      });

      it("treats the time range as inclusive on both ends", async () => {
        await storage.write([
          { ts: 100, node: "a", metric: "cpu", value: 1 },
          { ts: 200, node: "a", metric: "cpu", value: 2 },
          { ts: 300, node: "a", metric: "cpu", value: 3 },
          { ts: 400, node: "a", metric: "cpu", value: 4 },
        ]);

        const points = await storage.query({ from: 200, to: 300 });

        expect(points.map((point) => point.value).sort()).toEqual([2, 3]);
      });

      it("combines filters instead of applying only the last one", async () => {
        await storage.write([
          { ts: 100, node: "a", metric: "cpu", value: 1 },
          { ts: 200, node: "a", metric: "mem", value: 2 },
          { ts: 200, node: "b", metric: "cpu", value: 3 },
          { ts: 200, node: "a", metric: "cpu", value: 4 },
        ]);

        const points = await storage.query({
          node: "a",
          metric: "cpu",
          from: 150,
        });

        expect(points.map((point) => point.value)).toEqual([4]);
      });

      it("returns the newest points first", async () => {
        await storage.write([
          { ts: 200, node: "a", metric: "cpu", value: 2 },
          { ts: 100, node: "a", metric: "cpu", value: 1 },
          { ts: 300, node: "a", metric: "cpu", value: 3 },
        ]);

        const points = await storage.query({});

        expect(points.map((point) => point.ts)).toEqual([300, 200, 100]);
      });

      it("limit keeps the newest points, not an arbitrary subset", async () => {
        await storage.write([
          { ts: 100, node: "a", metric: "cpu", value: 1 },
          { ts: 200, node: "a", metric: "cpu", value: 2 },
          { ts: 300, node: "a", metric: "cpu", value: 3 },
        ]);

        const points = await storage.query({ limit: 2 });

        expect(points.map((point) => point.ts)).toEqual([300, 200]);
      });

      it("returns nothing when the filter matches nothing", async () => {
        await storage.write([{ ts: 100, node: "a", metric: "cpu", value: 1 }]);

        expect(await storage.query({ node: "absent" })).toEqual([]);
      });
    });

    describe("latest", () => {
      it("returns nothing for an empty database", async () => {
        expect(await storage.latest()).toEqual([]);
      });

      it("returns one point per node and metric", async () => {
        await storage.write([
          { ts: 100, node: "a", metric: "cpu", value: 1 },
          { ts: 200, node: "a", metric: "cpu", value: 2 },
          { ts: 100, node: "a", metric: "mem", value: 3 },
          { ts: 150, node: "b", metric: "cpu", value: 4 },
        ]);

        const latest = await storage.latest();

        expect(sortedKeys(latest)).toEqual(["a/cpu", "a/mem", "b/cpu"]);
        expect(valueFor(latest, "a", "cpu")).toBe(2);
      });

      it("carries the timestamp of the value it returns", async () => {
        await storage.write([
          { ts: 100, node: "a", metric: "cpu", value: 1 },
          { ts: 200, node: "a", metric: "cpu", value: 2 },
        ]);

        expect((await storage.latest())[0]?.ts).toBe(200);
      });

      it("is not moved backwards by a later write with an older timestamp", async () => {
        await storage.write([{ ts: 200, node: "a", metric: "cpu", value: 2 }]);
        await storage.write([{ ts: 100, node: "a", metric: "cpu", value: 1 }]);

        const [point] = await storage.latest();

        expect(point?.value).toBe(2);
        expect(point?.ts).toBe(200);
      });

      it("follows a value that was written across separate batches", async () => {
        await storage.write([{ ts: 100, node: "a", metric: "cpu", value: 1 }]);
        await storage.write([{ ts: 200, node: "a", metric: "cpu", value: 2 }]);

        expect((await storage.latest())[0]?.value).toBe(2);
      });

      it("restricts to one node when asked", async () => {
        await storage.write([
          { ts: 100, node: "a", metric: "cpu", value: 1 },
          { ts: 100, node: "b", metric: "cpu", value: 2 },
        ]);

        const latest = await storage.latest("b");

        expect(sortedKeys(latest)).toEqual(["b/cpu"]);
      });

      it("preserves ok and meta, not only value", async () => {
        await storage.write([
          {
            ts: 100,
            node: "a",
            metric: "reachability.verdict",
            ok: false,
            meta: { verdict: "blocked" },
          },
        ]);

        const [point] = await storage.latest();

        expect(point?.ok).toBe(false);
        expect(point?.meta).toEqual({ verdict: "blocked" });
      });
    });

    describe("prune", () => {
      it("removes points older than the cutoff and keeps the cutoff itself", async () => {
        await storage.write([
          { ts: 100, node: "a", metric: "cpu", value: 1 },
          { ts: 200, node: "a", metric: "cpu", value: 2 },
          { ts: 300, node: "a", metric: "cpu", value: 3 },
        ]);

        const removed = await storage.prune(200);

        expect(removed).toBe(1);
        expect((await storage.query({})).map((point) => point.ts)).toEqual([
          300, 200,
        ]);
      });

      it("reports zero when there is nothing old enough", async () => {
        await storage.write([{ ts: 300, node: "a", metric: "cpu", value: 1 }]);

        expect(await storage.prune(200)).toBe(0);
      });

      it("prunes every node, not just the first", async () => {
        await storage.write([
          { ts: 100, node: "a", metric: "cpu", value: 1 },
          { ts: 100, node: "b", metric: "cpu", value: 2 },
        ]);

        expect(await storage.prune(200)).toBe(2);
        expect(await storage.query({})).toEqual([]);
      });
    });
  });
}

function sortedKeys(points: { node: string; metric: string }[]): string[] {
  return points.map((point) => `${point.node}/${point.metric}`).sort();
}

function valueFor(
  points: { node: string; metric: string; value?: number }[],
  node: string,
  metric: string,
): number | undefined {
  return points.find((point) => point.node === node && point.metric === metric)
    ?.value;
}
