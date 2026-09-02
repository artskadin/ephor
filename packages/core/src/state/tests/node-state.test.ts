import { describe, expect, it } from "vitest";
import { parseConfig } from "../../config/load.js";
import { resolveConfig } from "../../config/resolve.js";
import { TEST_PROBES } from "../../config/tests/fixtures/probes.js";
import type { MetricPoint } from "../../types/metrics.js";
import { buildNodeState, type NodeState } from "../node-state.js";

const NOW = 1_800_000_000;

/**
 * Nodes come from a parsed config rather than hand-built objects: the
 * intervals staleness is judged against and the thresholds values are
 * compared to both arrive through inheritance, and a literal would quietly
 * stop matching what the config layer actually produces.
 */
function stateOf(
  config: Record<string, unknown>,
  points: readonly MetricPoint[],
  now: number = NOW,
): NodeState[] {
  const parsed = parseConfig(config, TEST_PROBES);

  return buildNodeState({
    nodes: resolveConfig(parsed, TEST_PROBES),
    points,
    now,
  });
}

function firstOf(
  config: Record<string, unknown>,
  points: readonly MetricPoint[],
  now: number = NOW,
): NodeState {
  const [state] = stateOf(config, points, now);

  if (!state) throw new Error("expected a state for the first node");

  return state;
}

const soloConfig = (
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ...extra,
  nodes: [{ name: "solo", host: "203.0.113.10", ssh: "solo" }],
});

const point = (
  metric: string,
  fields: Partial<MetricPoint> = {},
): MetricPoint => ({
  ts: NOW,
  node: "solo",
  metric,
  ...fields,
});

/** Fixture intervals: system 61s, reachability 301s. */
const SYSTEM_INTERVAL = 61;

/** Enough points to keep every probe from reporting "no data yet". */
const QUIET: MetricPoint[] = [
  point("system.up", { ok: true }),
  point("reachability.up", { ok: true }),
  point("reachability.verdict", {
    value: 0,
    ok: true,
    meta: { verdict: "ok" },
  }),
  point("speed.up", { ok: true }),
];

describe("buildNodeState", () => {
  it("reports one state per configured node, in config order", () => {
    const states = stateOf(
      {
        nodes: [
          { name: "first", host: "203.0.113.10" },
          { name: "second", host: "203.0.113.11" },
        ],
      },
      [],
    );

    expect(states.map((state) => state.node)).toEqual(["first", "second"]);
  });

  // The table must not warn about a node the user switched off on purpose;
  // false alarms are what make people stop reading a monitor.
  it("leaves out a node disabled in the config", () => {
    const states = stateOf(
      {
        nodes: [
          { name: "watched", host: "203.0.113.10" },
          { name: "retired", host: "203.0.113.11", enabled: false },
        ],
      },
      [point("system.load_percent", { value: 1, node: "retired" })],
    );

    expect(states.map((state) => state.node)).toEqual(["watched"]);
  });

  it("ignores points belonging to a node that is not configured", () => {
    const state = firstOf(soloConfig(), [
      ...QUIET,
      point("system.load_percent", { value: 99, node: "someone-else" }),
    ]);

    expect(state.metrics.map((view) => view.metric)).not.toContain(
      "system.load_percent",
    );
  });

  describe("a node with nothing recorded yet", () => {
    it("is unknown rather than ok", () => {
      const state = firstOf(soloConfig(), []);

      expect(state.status).toBe("unknown");
    });

    it("says which probe has not reported", () => {
      const state = firstOf(soloConfig(), []);

      expect(state.reasons).toContain("system has not reported yet");
    });
  });

  describe("thresholds", () => {
    const withDisk = soloConfig({
      thresholds: { "system.disk_percent": { warn: 85, critical: 95 } },
    });

    it("leaves a value below the warn bound alone", () => {
      const state = firstOf(withDisk, [
        ...QUIET,
        point("system.disk_percent", { value: 84 }),
      ]);

      expect(state.status).toBe("ok");
      expect(viewOf(state, "system.disk_percent").breached).toBeUndefined();
    });

    // Strictly past the bound: a threshold of 85 is the last acceptable
    // value, not the first bad one.
    it("leaves a value exactly on the bound alone", () => {
      const state = firstOf(withDisk, [
        ...QUIET,
        point("system.disk_percent", { value: 85 }),
      ]);

      expect(state.status).toBe("ok");
    });

    it("warns one step past the warn bound", () => {
      const state = firstOf(withDisk, [
        ...QUIET,
        point("system.disk_percent", { value: 86 }),
      ]);

      expect(state.status).toBe("warn");
      expect(viewOf(state, "system.disk_percent").breached).toBe("warn");
    });

    it("reaches critical past the critical bound", () => {
      const state = firstOf(withDisk, [
        ...QUIET,
        point("system.disk_percent", { value: 96 }),
      ]);

      expect(state.status).toBe("critical");
      expect(viewOf(state, "system.disk_percent").breached).toBe("critical");
    });

    it("says which number crossed which bound", () => {
      const state = firstOf(withDisk, [
        ...QUIET,
        point("system.disk_percent", { value: 96 }),
      ]);

      expect(state.reasons).toContain(
        "system.disk_percent is 96, above the critical threshold of 95",
      );
    });

    // The case the falling form exists for: a rented link that turns out to
    // run at 1.5 Gbit/s must not be reported as slow.
    it("compares a falling metric the other way round", () => {
      const config = soloConfig({
        probes: { speed: { enabled: true } },
        thresholds: { "speed.download_mbps": { warn: 50, critical: 20 } },
      });

      const fast = firstOf(config, [
        ...QUIET,
        point("speed.download_mbps", { value: 1500 }),
      ]);
      const slow = firstOf(config, [
        ...QUIET,
        point("speed.download_mbps", { value: 19 }),
      ]);

      expect(fast.status).toBe("ok");
      expect(slow.status).toBe("critical");
      expect(slow.reasons).toContain(
        "speed.download_mbps is 19, below the critical threshold of 20",
      );
    });

    // A value whose normal range the user has not decided on is shown and
    // never coloured, which is the whole point of thresholds being optional.
    it("never colours a metric nobody set a threshold for", () => {
      const state = firstOf(soloConfig(), [
        ...QUIET,
        point("system.disk_percent", { value: 99 }),
      ]);

      expect(state.status).toBe("ok");
      expect(viewOf(state, "system.disk_percent").status).toBe("ok");
    });

    it("uses the node's own threshold over the global one", () => {
      const config = {
        thresholds: { "system.disk_percent": { warn: 85, critical: 95 } },
        nodes: [
          {
            name: "solo",
            host: "203.0.113.10",
            ssh: "solo",
            thresholds: { "system.disk_percent": { warn: 60, critical: 70 } },
          },
        ],
      };

      const state = firstOf(config, [
        ...QUIET,
        point("system.disk_percent", { value: 65 }),
      ]);

      expect(state.status).toBe("warn");
    });

    it("stops watching a metric the node nulled out", () => {
      const config = {
        thresholds: { "system.disk_percent": { warn: 85, critical: 95 } },
        nodes: [
          {
            name: "archive",
            host: "203.0.113.10",
            ssh: "archive",
            thresholds: { "system.disk_percent": null },
          },
        ],
      };

      const state = firstOf(config, [
        point("system.up", { ok: true, node: "archive" }),
        point("reachability.up", { ok: true, node: "archive" }),
        point("reachability.verdict", {
          value: 0,
          ok: true,
          meta: { verdict: "ok" },
          node: "archive",
        }),
        point("speed.up", { ok: true, node: "archive" }),
        point("system.disk_percent", { value: 92, node: "archive" }),
      ]);

      expect(state.status).toBe("ok");
    });
  });

  describe("staleness", () => {
    const withDisk = soloConfig({
      thresholds: { "system.disk_percent": { warn: 85, critical: 95 } },
    });

    const agedBy = (seconds: number): MetricPoint[] =>
      QUIET.map((entry) => ({ ...entry, ts: NOW - seconds })).concat(
        point("system.disk_percent", { value: 12, ts: NOW - seconds }),
      );

    it("accepts a value exactly two intervals old", () => {
      const state = firstOf(withDisk, agedBy(SYSTEM_INTERVAL * 2));

      expect(viewOf(state, "system.disk_percent").status).toBe("ok");
    });

    it("calls a value one second older than that stale", () => {
      const state = firstOf(withDisk, agedBy(SYSTEM_INTERVAL * 2 + 1));

      expect(viewOf(state, "system.disk_percent").status).toBe("stale");
      expect(state.status).toBe("stale");
    });

    // A monitor showing green from four-day-old numbers is worse than no
    // monitor: the value was fine when it was measured and says nothing now.
    it("does not compare a stale value against its threshold", () => {
      const state = firstOf(withDisk, [
        ...QUIET,
        point("system.disk_percent", { value: 12, ts: NOW - 400_000 }),
      ]);

      expect(viewOf(state, "system.disk_percent").status).toBe("stale");
      expect(viewOf(state, "system.disk_percent").breached).toBeUndefined();
    });

    it("carries the age and the expected interval for every value", () => {
      const state = firstOf(withDisk, agedBy(150));
      const view = viewOf(state, "system.disk_percent");

      expect(view.ageSeconds).toBe(150);
      expect(view.expectedEverySeconds).toBe(SYSTEM_INTERVAL);
    });

    // Each probe is judged against its own interval, which is why a single
    // "last seen" for the row was dropped: a daily probe would hold every
    // row red while the node is perfectly fine.
    it("judges a slow probe against its own interval, not another's", () => {
      const dayOld = 21 * 3600;
      const state = firstOf(
        soloConfig({ probes: { speed: { enabled: true, interval: "24h" } } }),
        [
          ...QUIET,
          point("speed.download_mbps", { value: 455, ts: NOW - dayOld }),
        ],
      );

      expect(viewOf(state, "speed.download_mbps").status).toBe("ok");
      expect(state.status).toBe("ok");
    });

    it("names the probe and both durations once, not once per value", () => {
      const state = firstOf(withDisk, agedBy(7 * 3600));

      expect(
        state.reasons.filter((reason) => reason.startsWith("system last")),
      ).toEqual(["system last reported 7h ago, expected every 1m"]);
    });

    // A node whose clock runs ahead sends a point from the future; a negative
    // age would print as a nonsense duration.
    it("treats a point from the future as brand new", () => {
      const state = firstOf(withDisk, [
        ...QUIET,
        point("system.disk_percent", { value: 12, ts: NOW + 500 }),
      ]);

      expect(viewOf(state, "system.disk_percent").ageSeconds).toBe(0);
      expect(viewOf(state, "system.disk_percent").status).toBe("ok");
    });
  });

  // Found by running the collector against live nodes: narrowing
  // `probes.reachability.methods` left the ping rows in `metrics_latest`,
  // which is never pruned, and they held a healthy node at `stale` for as
  // long as the database lived.
  describe("a metric the probe has stopped writing", () => {
    const narrowed = (): MetricPoint[] => [
      point("system.up", { ok: true }),
      point("speed.up", { ok: true }),
      point("reachability.up", { ok: true }),
      point("reachability.verdict", {
        value: 0,
        ok: true,
        meta: { verdict: "ok" },
      }),
      point("reachability.eu.tcp", { value: 1, ok: true }),
      // Written back when `methods` still listed ping, and never again.
      point("reachability.eu.ping", { value: 1, ok: true, ts: NOW - 400_000 }),
    ];

    it("stops being reported at all", () => {
      const state = firstOf(soloConfig(), narrowed());

      expect(state.metrics.map((view) => view.metric)).not.toContain(
        "reachability.eu.ping",
      );
    });

    it("does not hold the node stale", () => {
      const state = firstOf(soloConfig(), narrowed());

      expect(state.status).toBe("ok");
      expect(state.reasons).toEqual([]);
    });

    // The window between the two thresholds is what makes a method that
    // quietly stopped answering visible instead of making it disappear.
    it("is still stale rather than retired a few misses in", () => {
      const state = firstOf(soloConfig(), [
        point("system.up", { ok: true }),
        point("speed.up", { ok: true }),
        point("reachability.up", { ok: true }),
        point("reachability.verdict", {
          value: 0,
          ok: true,
          meta: { verdict: "ok" },
        }),
        point("reachability.eu.tcp", { value: 1, ok: true }),
        point("reachability.eu.ping", {
          value: 1,
          ok: true,
          // Reachability's fixture interval is 301s, so stale past 602s and
          // retired past 3010s. This sits between the two.
          ts: NOW - 1000,
        }),
      ]);

      expect(viewOf(state, "reachability.eu.ping").status).toBe("stale");
      expect(state.status).toBe("stale");
    });

    // The whole probe going quiet is the case staleness exists for, and the
    // retirement rule must not swallow it.
    it("keeps every value when the probe itself went silent", () => {
      const silent = QUIET.map((entry) => ({ ...entry, ts: NOW - 400_000 }));
      const state = firstOf(soloConfig(), [
        ...silent,
        point("system.disk_percent", { value: 12, ts: NOW - 400_000 }),
      ]);

      expect(viewOf(state, "system.disk_percent").status).toBe("stale");
      expect(state.status).toBe("stale");
    });
  });

  describe("a probe that could not run", () => {
    const failing: MetricPoint[] = [
      point("system.up", {
        ok: false,
        meta: { errorKind: "auth_failed", detail: "Permission denied" },
      }),
      point("reachability.up", { ok: true }),
      point("reachability.verdict", {
        value: 0,
        ok: true,
        meta: { verdict: "ok" },
      }),
      point("speed.up", { ok: true }),
    ];

    // Failing ssh says the node is unreachable on port 22. It is not proof
    // the machine is gone, so this warns rather than declaring it dead.
    it("warns rather than calling the node down", () => {
      const state = firstOf(soloConfig(), failing);

      expect(state.status).toBe("warn");
    });

    it("says which probe failed and why", () => {
      const state = firstOf(soloConfig(), failing);

      expect(state.reasons).toContain(
        "system probe failing: auth_failed (Permission denied)",
      );
    });

    // Reachability needs no access to the node, so a broken ssh must not
    // cast doubt on it.
    it("leaves the reachability verdict untouched", () => {
      const state = firstOf(soloConfig(), failing);

      expect(state.reachability).toBe("ok");
    });

    // Retries and a transient ssh hiccup should not blank the table: the
    // last values were measured recently and were fine.
    it("keeps recent values from before the failure", () => {
      const state = firstOf(soloConfig(), [
        ...failing,
        point("system.disk_percent", { value: 12, ts: NOW - 10 }),
      ]);

      expect(viewOf(state, "system.disk_percent").status).toBe("ok");
      expect(viewOf(state, "system.disk_percent").value).toBe(12);
    });
  });

  describe("reachability", () => {
    const withVerdict = (verdict: string, ts: number = NOW): MetricPoint[] => [
      point("system.up", { ok: true }),
      point("reachability.up", { ok: true, ts }),
      point("speed.up", { ok: true }),
      point("reachability.verdict", {
        ok: verdict === "ok",
        meta: { verdict },
        ts,
      }),
    ];

    it("reports the verdict the probe decided", () => {
      expect(firstOf(soloConfig(), withVerdict("blocked")).reachability).toBe(
        "blocked",
      );
    });

    it.each([
      ["ok", "ok"],
      ["partial", "warn"],
      ["blocked", "critical"],
      ["down", "critical"],
    ])("folds %s into %s", (verdict, expected) => {
      expect(firstOf(soloConfig(), withVerdict(verdict)).status).toBe(expected);
    });

    // Which of the two it is stays in the verdict, where a reader looks for
    // it; the summary only answers "does this need me now".
    it("keeps blocked and down apart even though both are critical", () => {
      expect(firstOf(soloConfig(), withVerdict("blocked")).reachability).toBe(
        "blocked",
      );
      expect(firstOf(soloConfig(), withVerdict("down")).reachability).toBe(
        "down",
      );
    });

    it("explains the verdict in words", () => {
      expect(firstOf(soloConfig(), withVerdict("blocked")).reasons).toContain(
        "not reachable from the required regions while the control group answers",
      );
    });

    // A four-day-old `blocked` describes what was true four days ago.
    it("does not let a stale verdict drive today's status", () => {
      const state = firstOf(soloConfig(), withVerdict("down", NOW - 400_000));

      expect(state.status).toBe("stale");
      expect(state.reachability).toBe("down");
      expect(state.reasons).not.toContain(
        "not reachable from any region, the control group included",
      );
    });

    // `null` is "we do not measure this node", which is not the same answer
    // as "we do and cannot tell".
    it("is null when the probe is switched off for the node", () => {
      const state = firstOf(
        {
          nodes: [
            {
              name: "home-lab",
              host: "192.168.1.10",
              ssh: "home-lab",
              probes: { reachability: { enabled: false } },
            },
          ],
        },
        [
          point("system.up", { ok: true, node: "home-lab" }),
          point("speed.up", { ok: true, node: "home-lab" }),
        ],
      );

      expect(state.reachability).toBeNull();
      expect(state.status).toBe("ok");
    });

    it("ignores leftovers from a probe that was switched off", () => {
      const state = firstOf(
        {
          nodes: [
            {
              name: "home-lab",
              host: "192.168.1.10",
              ssh: "home-lab",
              probes: { reachability: { enabled: false } },
            },
          ],
        },
        [
          point("system.up", { ok: true, node: "home-lab" }),
          point("speed.up", { ok: true, node: "home-lab" }),
          point("reachability.verdict", {
            meta: { verdict: "down" },
            node: "home-lab",
            ts: NOW - 400_000,
          }),
        ],
      );

      expect(state.status).toBe("ok");
      expect(state.metrics.map((view) => view.metric)).not.toContain(
        "reachability.verdict",
      );
    });

    // The probe already weighed these readings against the quorum and the
    // control group; its answer is the verdict. Repeating them would bury the
    // one line that says what happened under five that say nothing.
    it("lets the verdict speak for the readings behind it", () => {
      const state = firstOf(soloConfig(), [
        ...withVerdict("down"),
        point("reachability.ru.tcp", { value: 0, ok: false }),
        point("reachability.eu.tcp", { value: 0, ok: false }),
      ]);

      expect(state.reasons).toEqual([
        "not reachable from any region, the control group included",
      ]);
      expect(viewOf(state, "reachability.ru.tcp").value).toBe(0);
    });

    // check-host documents no rate limit, so it refusing requests is the
    // expected way this probe breaks. The rule that quiets region readings
    // must not quiet the record of whether the probe ran at all.
    it("marks the node when the probe itself could not run", () => {
      const state = firstOf(soloConfig(), [
        point("system.up", { ok: true }),
        point("speed.up", { ok: true }),
        point("reachability.up", {
          ok: false,
          meta: { errorKind: "rate_limited" },
        }),
        point("reachability.verdict", {
          ok: true,
          meta: { verdict: "ok" },
        }),
      ]);

      expect(state.status).toBe("warn");
      expect(state.reasons).toContain(
        "reachability probe failing: rate_limited",
      );
    });

    // The control group failing while the required regions pass is the
    // probe's business too: it decided that verdict knowing both.
    it("does not warn on a failed reading the verdict called ok", () => {
      const state = firstOf(soloConfig(), [
        ...withVerdict("ok"),
        point("reachability.eu.tcp", { value: 0, ok: false }),
      ]);

      expect(state.status).toBe("ok");
    });

    it("is unknown when the probe runs but wrote no verdict", () => {
      const state = firstOf(soloConfig(), [
        point("system.up", { ok: true }),
        point("reachability.up", { ok: true }),
        point("speed.up", { ok: true }),
      ]);

      expect(state.reachability).toBe("unknown");
    });
  });

  // A node nobody paid for any more: the provider took it away, so nothing
  // answers from outside, and it was never given an ssh target, so the
  // system probe was switched off for want of an executor rather than by the
  // user. The two reasons a probe can be off must read the same here.
  it("reads a node that was switched off by its provider", () => {
    const state = firstOf(
      {
        nodes: [{ name: "german", host: "144.31.73.62", ports: [443] }],
      },
      [
        point("reachability.up", { ok: true, node: "german" }),
        point("reachability.verdict", {
          value: 3,
          ok: false,
          meta: { verdict: "down" },
          node: "german",
        }),
        point("reachability.ru.tcp", { value: 0, ok: false, node: "german" }),
        point("reachability.eu.tcp", { value: 0, ok: false, node: "german" }),
      ],
    );

    expect(state.status).toBe("critical");
    expect(state.reachability).toBe("down");
    expect(state.reasons).toEqual([
      "not reachable from any region, the control group included",
    ]);
    // No ssh target means no system axis at all, so the row shows dashes
    // rather than warning about a probe the user never asked for.
    expect(state.metrics.some((view) => view.probe === "system")).toBe(false);
  });

  describe("the worst metric decides", () => {
    const withDisk = soloConfig({
      thresholds: {
        "system.disk_percent": { warn: 85, critical: 95 },
        "system.mem_percent": { warn: 85, critical: 95 },
      },
    });

    it("critical beats warn", () => {
      const state = firstOf(withDisk, [
        ...QUIET,
        point("system.mem_percent", { value: 86 }),
        point("system.disk_percent", { value: 96 }),
      ]);

      expect(state.status).toBe("critical");
    });

    // One probe silent while another reports: the whole reachability probe
    // goes quiet together, which is what staleness is for, while `system`
    // keeps reporting a value over its warn bound.
    const systemWarnAndReachabilitySilent = (
      memPercent: number,
    ): MetricPoint[] => [
      point("system.up", { ok: true }),
      point("speed.up", { ok: true }),
      point("system.mem_percent", { value: memPercent }),
      point("reachability.up", { ok: true, ts: NOW - 400_000 }),
      point("reachability.verdict", {
        value: 0,
        ok: true,
        meta: { verdict: "ok" },
        ts: NOW - 400_000,
      }),
    ];

    // Blindness is worse than a known small problem: a node we cannot see
    // could be in trouble right now.
    it("stale beats warn", () => {
      const state = firstOf(withDisk, systemWarnAndReachabilitySilent(86));

      expect(state.status).toBe("stale");
    });

    it("critical beats stale", () => {
      const state = firstOf(withDisk, systemWarnAndReachabilitySilent(96));

      expect(state.status).toBe("critical");
    });

    it("keeps every reason, not only the worst one", () => {
      const state = firstOf(withDisk, [
        ...QUIET,
        point("system.mem_percent", { value: 86 }),
        point("system.disk_percent", { value: 96 }),
      ]);

      expect(state.reasons).toEqual(
        expect.arrayContaining([
          "system.mem_percent is 86, above the warn threshold of 85",
          "system.disk_percent is 96, above the critical threshold of 95",
        ]),
      );
    });

    it("has no reasons when everything is fine", () => {
      const state = firstOf(withDisk, [
        ...QUIET,
        point("system.disk_percent", { value: 12 }),
      ]);

      expect(state.status).toBe("ok");
      expect(state.reasons).toEqual([]);
    });
  });
});

function viewOf(state: NodeState, metric: string) {
  const view = state.metrics.find((candidate) => candidate.metric === metric);

  if (!view) throw new Error(`expected a view for ${metric}`);

  return view;
}
