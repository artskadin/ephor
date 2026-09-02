import { describe, expect, it } from "vitest";
import { SqliteStorage } from "../../storage/sqlite-storage.js";
import {
  type ApiDeps,
  getHealth,
  getMetrics,
  getNode,
  getState,
  InvalidQueryError,
} from "../handlers.js";
import { depsOf, NOW, storageOf } from "./fixtures.js";

describe("getState", () => {
  it("reports the collector's own clock", async () => {
    const state = await getState(depsOf([]));

    expect(state.now).toBe(NOW);
  });

  it("summarises every watched node", async () => {
    const state = await getState(
      depsOf([
        { ts: NOW, node: "achilles", metric: "system.up", ok: true },
        {
          ts: NOW,
          node: "achilles",
          metric: "system.disk_percent",
          value: 12.5,
        },
      ]),
    );

    expect(state.nodes.map((node) => node.node)).toEqual(["achilles"]);
    expect(
      state.nodes[0]?.metrics.find(
        (view) => view.metric === "system.disk_percent",
      )?.value,
    ).toBe(12.5);
  });

  // The node was switched off on purpose; reporting it would be a false
  // alarm, and the API is where the client's list comes from.
  it("leaves a disabled node out", async () => {
    const state = await getState(
      depsOf([{ ts: NOW, node: "retired", metric: "system.up", ok: true }]),
    );

    expect(state.nodes.map((node) => node.node)).not.toContain("retired");
  });

  it("ages values against the clock it was given, not the wall clock", async () => {
    const state = await getState(
      depsOf([
        { ts: NOW - 45, node: "achilles", metric: "system.up", ok: true },
      ]),
    );

    expect(
      state.nodes[0]?.metrics.find((view) => view.metric === "system.up")
        ?.ageSeconds,
    ).toBe(45);
  });
});

describe("getNode", () => {
  it("returns the one node asked for", async () => {
    const found = await getNode(
      depsOf([
        { ts: NOW - 5, node: "achilles", metric: "system.up", ok: true },
      ]),
      "achilles",
    );

    expect(found?.now).toBe(NOW);
    expect(found?.node.node).toBe("achilles");
    expect(
      found?.node.metrics.find((view) => view.metric === "system.up")
        ?.ageSeconds,
    ).toBe(5);
  });

  it("is undefined for a name that is not configured", async () => {
    expect(await getNode(depsOf([]), "nobody")).toBeUndefined();
  });

  // Switched off on purpose is the same as not there, for the API too.
  it("is undefined for a node that is disabled", async () => {
    expect(await getNode(depsOf([]), "retired")).toBeUndefined();
  });

  // `latest(node)` exists for exactly this; fetching the fleet and keeping
  // one bucket is ~200x the work at the scale the project targets.
  it("asks the storage for that node alone", async () => {
    const storage = storageOf([]);

    await getNode(depsOf([], { storage }), "achilles");

    expect(storage.latestCalls).toEqual(["achilles"]);
  });
});

/**
 * The real driver rather than a fake: truncation is detected by asking for
 * one row more than the limit, and only a storage that honours `limit`,
 * `from` and `to` exactly as the contract says can prove that works.
 */
describe("getMetrics", () => {
  const withHistory = async (count: number): Promise<ApiDeps> => {
    const storage = new SqliteStorage(":memory:");
    await storage.migrate();

    // One point a minute, newest at NOW, so `count` points span
    // `count - 1` minutes back.
    await storage.write(
      Array.from({ length: count }, (_, index) => ({
        ts: NOW - index * 60,
        node: "achilles",
        metric: "system.load_percent",
        value: index,
      })),
    );

    return depsOf([], { storage });
  };

  it("defaults to the last hour, newest first", async () => {
    // 200 minutes of history; the last hour holds points at 0..60 minutes.
    const response = await getMetrics(await withHistory(200), {});

    expect(response.from).toBe(NOW - 3600);
    expect(response.to).toBe(NOW);
    expect(response.points).toHaveLength(61);
    expect(response.points[0]?.ts).toBe(NOW);
    expect(response.points.at(-1)?.ts).toBe(NOW - 3600);
  });

  it("defaults the limit to a thousand and says so", async () => {
    const response = await getMetrics(await withHistory(5), {});

    expect(response.limit).toBe(1000);
    expect(response.truncated).toBe(false);
  });

  it("honours an explicit window", async () => {
    const response = await getMetrics(await withHistory(200), {
      from: NOW - 600,
      to: NOW - 300,
    });

    expect(response.points.map((point) => point.ts)).toEqual([
      NOW - 300,
      NOW - 360,
      NOW - 420,
      NOW - 480,
      NOW - 540,
      NOW - 600,
    ]);
  });

  it("cuts at the limit and admits it", async () => {
    const response = await getMetrics(await withHistory(200), {
      from: 0,
      limit: 50,
    });

    expect(response.points).toHaveLength(50);
    expect(response.truncated).toBe(true);
  });

  // A page that happens to be exactly full is not a cut page.
  it("does not claim truncation when the window holds exactly the limit", async () => {
    const response = await getMetrics(await withHistory(50), {
      from: 0,
      limit: 50,
    });

    expect(response.points).toHaveLength(50);
    expect(response.truncated).toBe(false);
  });

  it("filters by node and metric", async () => {
    const storage = new SqliteStorage(":memory:");
    await storage.migrate();
    await storage.write([
      { ts: NOW, node: "achilles", metric: "system.load_percent", value: 1 },
      { ts: NOW, node: "achilles", metric: "system.mem_percent", value: 2 },
      { ts: NOW, node: "other", metric: "system.load_percent", value: 3 },
    ]);

    const response = await getMetrics(depsOf([], { storage }), {
      node: "achilles",
      metric: "system.mem_percent",
    });

    expect(response.points.map((point) => point.value)).toEqual([2]);
  });

  // The schema promises a non-negative `from`; the default must keep that
  // promise too, or the response hands back a number its own input refuses.
  it("never defaults from below zero", async () => {
    const response = await getMetrics(await withHistory(1), { to: 100 });

    expect(response.from).toBe(0);
  });

  // The schema only compares the two when both were supplied.
  it("refuses a from later than the defaulted to", async () => {
    await expect(
      getMetrics(await withHistory(1), { from: NOW + 1 }),
    ).rejects.toThrow(InvalidQueryError);
  });

  describe("a page cut inside one instant", () => {
    // One probe run: four metrics, one ts. Two such runs a minute apart.
    const twoRuns = async (): Promise<ApiDeps> => {
      const storage = new SqliteStorage(":memory:");
      await storage.migrate();

      for (const ts of [NOW, NOW - 60]) {
        await storage.write(
          ["disk_percent", "load_percent", "mem_percent", "up"].map((name) => ({
            ts,
            node: "achilles",
            metric: `system.${name}`,
            value: 1,
          })),
        );
      }

      return depsOf([], { storage });
    };

    // A client paging by window continues from `oldest.ts - 1`. A page that
    // ends halfway through NOW would leave two of NOW's metrics unreachable
    // for good, so the cut moves back to the last complete instant.
    it("moves the cut back to the last complete instant", async () => {
      const response = await getMetrics(await twoRuns(), {
        from: 0,
        limit: 6,
      });

      expect(response.truncated).toBe(true);
      expect(response.points.map((point) => point.ts)).toEqual([
        NOW,
        NOW,
        NOW,
        NOW,
      ]);
    });

    it("keeps a page that already ends on a complete instant", async () => {
      const response = await getMetrics(await twoRuns(), {
        from: 0,
        limit: 4,
      });

      expect(response.truncated).toBe(true);
      expect(response.points).toHaveLength(4);
    });

    // A limit smaller than one instant cannot page cleanly by construction;
    // returning nothing would be worse than returning the cut page.
    it("returns the cut page when one instant is wider than the limit", async () => {
      const response = await getMetrics(await twoRuns(), {
        from: 0,
        limit: 2,
      });

      expect(response.truncated).toBe(true);
      expect(response.points).toHaveLength(2);
    });
  });
});

describe("getHealth", () => {
  it("reports uptime, work in flight and what is watched", () => {
    expect(getHealth(depsOf([]))).toEqual({
      ok: true,
      uptimeSeconds: 3600,
      runningTasks: 2,
      nodes: 1,
      probes: ["system", "reachability"],
    });
  });

  // ntp correcting a fresh VPS steps the clock backwards; a negative uptime
  // would be printed as a nonsense duration by every client.
  it("never reports a negative uptime", () => {
    const health = getHealth(depsOf([], { startedAt: NOW + 500 }));

    expect(health.uptimeSeconds).toBe(0);
  });
});
