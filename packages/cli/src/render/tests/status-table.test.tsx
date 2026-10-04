import {
  type Acknowledgement,
  buildNodeState,
  type MetricPoint,
  type ProbeDescriptor,
  parseConfig,
  resolveConfig,
  type StateResponse,
} from "@ephorate/core";
import { cleanup, render } from "ink-testing-library";
import type { ReactElement } from "react";
import { afterAll, describe, expect, it, vi } from "vitest";
import { frameOf } from "../frame";
import { nodeHeights, StatusTable, statusTableWidth } from "../status-table";

// Ink paints through chalk, which decides at import whether the process
// may use colour; under a test runner it may not. Forced on before ink is
// imported, so a tint asked for is a tint written and the tests can see it.
// Each test file runs in its own process, so nothing else sees the change;
// it is undone anyway.
vi.hoisted(() => {
  process.env.FORCE_COLOR = "1";
});

afterAll(() => {
  cleanup();
  delete process.env.FORCE_COLOR;
});

const NOW = 1_800_000_000;

/**
 * Two probes with the shipped intervals: a minute for `system`, five for
 * `reachability`. Only the names and intervals matter to the table, so the
 * descriptors are written here rather than borrowed from the collector,
 * which the client does not depend on.
 */
const SYSTEM: ProbeDescriptor = {
  name: "system",
  requiresExecutor: true,
  enabledByDefault: true,
  defaults: { interval: 60, timeout: 20, retries: 0, concurrency: 50 },
};

const REACHABILITY: ProbeDescriptor = {
  name: "reachability",
  requiresExecutor: false,
  enabledByDefault: true,
  defaults: { interval: 300, timeout: 60, retries: 0, concurrency: 50 },
};

const PROBES = [SYSTEM, REACHABILITY];

/**
 * States come from `buildNodeState` over real points, not from literals:
 * the ages, statuses and reasons the table shows are the collector's, and
 * a hand-written `NodeState` would test the table against itself.
 */
function stateOf(
  config: Record<string, unknown>,
  points: readonly MetricPoint[],
  acknowledgements: Acknowledgement[] = [],
): StateResponse {
  const parsed = parseConfig(config, PROBES);

  return {
    now: NOW,
    nodes: buildNodeState({
      nodes: resolveConfig(parsed, PROBES),
      points,
      now: NOW,
      acknowledgements,
    }),
  };
}

const at = (secondsAgo: number) => NOW - secondsAgo;

function systemPoints(
  node: string,
  ts: number,
  values: { load: number; mem: number; disk: number },
  ports: { ok: boolean; missing?: string[]; undeclared?: number[] } = {
    ok: true,
  },
): MetricPoint[] {
  return [
    { ts, node, metric: "system.up", ok: true },
    { ts, node, metric: "system.load_percent", value: values.load },
    { ts, node, metric: "system.mem_percent", value: values.mem },
    { ts, node, metric: "system.disk_percent", value: values.disk },
    {
      ts,
      node,
      metric: "system.ports",
      value: 1,
      ok: ports.ok,
      meta: {
        listening: [443],
        undeclared: ports.undeclared ?? [],
        missing: ports.missing ?? [],
      },
    },
  ];
}

function reachabilityPoints(
  node: string,
  ts: number,
  verdict: "ok" | "down",
): MetricPoint[] {
  return [
    { ts, node, metric: "reachability.up", ok: true },
    {
      ts,
      node,
      metric: "reachability.verdict",
      value: verdict === "ok" ? 0 : 3,
      ok: verdict === "ok",
      meta: { verdict },
    },
  ];
}

/**
 * Five nodes, one of each kind: fine; a declared port nobody listens on;
 * no ssh and unreachable; both probes gone quiet on bad news — a disk past
 * its critical bound, an unreachable verdict — so a stale value has
 * something to say; just added.
 */
const FLEET = {
  // One bound, so the fixture must say which side of it is bad.
  thresholds: { "system.disk_percent": { critical: 95, worseWhen: "above" } },
  nodes: [
    { name: "achilles", host: "203.0.113.10", ssh: "achilles", ports: [443] },
    {
      name: "antilochus",
      host: "203.0.113.11",
      ssh: "antilochus",
      ports: [443],
    },
    { name: "german", host: "203.0.113.12", ports: [443] },
    { name: "hector", host: "203.0.113.13", ssh: "hector", ports: [443] },
    { name: "patroclus", host: "203.0.113.14", ssh: "patroclus" },
  ],
};

const FLEET_POINTS: MetricPoint[] = [
  ...systemPoints("achilles", at(30), { load: 3.2, mem: 41, disk: 62 }),
  ...reachabilityPoints("achilles", at(60), "ok"),
  ...systemPoints(
    "antilochus",
    at(30),
    { load: 2, mem: 40, disk: 87 },
    { ok: false, missing: ["443"] },
  ),
  ...reachabilityPoints("antilochus", at(60), "ok"),
  ...reachabilityPoints("german", at(120), "down"),
  ...systemPoints("hector", at(300), { load: 1, mem: 35, disk: 96 }),
  ...reachabilityPoints("hector", at(900), "down"),
];

/**
 * The last frame ink drew for the table. The library's stream is 100
 * columns wide; the fixtures stay well under that, so nothing wraps.
 */
function frame(state: StateResponse, colour: boolean): string {
  return (
    render(<StatusTable state={state} colour={colour} />).lastFrame() ?? ""
  );
}

/** The cells of a line, as a reader sees them: split on the column gaps. */
const cells = (line: string | undefined): string[] =>
  (line ?? "").trim().split(/\s{2,}/);

/**
 * The tinted runs of a line: the code that opened each, and its text. Ink
 * closes a run before it opens the next (seen on the bytes), so after
 * splitting on the escape byte the pieces alternate: an opening
 * `[<code>m<text>`, then a closing one. The byte is split on as a string,
 * as `stripped` does: a control character in a regex is a lint error.
 */
const spans = (line: string | undefined): [string, string][] => {
  const runs: [string, string][] = [];
  const pieces = (line ?? "").split("\u001b").slice(1);

  for (let index = 0; index < pieces.length; index += 2) {
    const opened = /^\[(\d+)m(.*)$/.exec(pieces[index] ?? "");
    if (opened) runs.push([opened[1] ?? "", opened[2] ?? ""]);
  }

  return runs;
};

/** The text without escape codes: what a `--plain` run prints. */
const stripped = (text: string): string =>
  text
    .split("\u001b")
    .map((piece, index) =>
      index === 0 ? piece : piece.replace(/^\[[0-9;]*m/, ""),
    )
    .join("");

/**
 * A node's lines, from its name to the next node: found by name, so a test
 * does not depend on where the order puts it. A node's own line is the one
 * that does not start with a space once the colour is gone.
 */
function blockOf(lines: readonly string[], name: string): string[] {
  const isNodeLine = (line: string) => !stripped(line).startsWith(" ");
  const start = lines.findIndex(
    (line, index) =>
      index > 0 &&
      isNodeLine(line) &&
      stripped(line).replace(/^! /, "").split(/\s/)[0] === name,
  );
  if (start === -1) throw new Error(`no node "${name}" in the table`);

  const next = lines.findIndex(
    (line, index) => index > start && isNodeLine(line),
  );
  return lines.slice(start, next === -1 ? undefined : next);
}

describe("StatusTable", () => {
  const plain = frame(stateOf(FLEET, FLEET_POINTS), false);
  const lines = plain.split("\n");

  it("draws a header, then values with their own ages under them", () => {
    expect(cells(lines[0])).toEqual([
      "NODE",
      "REACH",
      "LOAD",
      "MEM",
      "DISK",
      "PORTS",
    ]);
    const achilles = blockOf(lines, "achilles");
    expect(cells(achilles[0])).toEqual([
      "achilles",
      "ok",
      "3%",
      "41%",
      "62%",
      "443",
    ]);
    expect(cells(achilles[1])).toEqual(["1m", "30s", "30s", "30s", "30s"]);
    expect(achilles).toHaveLength(2);
  });

  // Critical, stale, warn, unknown, ok; within a status, by name.
  it("puts the worst nodes first", () => {
    const names = lines
      .slice(1)
      .filter((line) => !line.startsWith(" "))
      .map((line) => line.replace(/^! /, "").split(" ")[0]);

    expect(names).toEqual([
      "german",
      "hector",
      "antilochus",
      "patroclus",
      "achilles",
    ]);
  });

  it("orders nodes of one status by name, by code unit", () => {
    const state = stateOf(
      {
        nodes: ["b", "B", "a"].map((name, index) => ({
          name,
          host: `203.0.113.${20 + index}`,
        })),
      },
      [],
    );
    expect(new Set(state.nodes.map((node) => node.status))).toEqual(
      new Set(["unknown"]),
    );
    const names = frame(state, false)
      .split("\n")
      .filter((line, index) => index > 0 && !line.startsWith(" "))
      .map((line) => line.replace(/^! /, "").split(" ")[0]);

    expect(names).toEqual(["B", "a", "b"]);
  });

  it("marks a node that is not ok, and says why under it", () => {
    const antilochus = blockOf(lines, "antilochus");
    expect(cells(antilochus[0])).toEqual([
      "! antilochus",
      "ok",
      "2%",
      "40%",
      "87%",
      "missing 443",
    ]);
    expect(cells(antilochus[1])).toEqual(["1m", "30s", "30s", "30s", "30s"]);
    expect(antilochus[2]).toBe("  system.ports reports a problem");
  });

  it("dashes the columns of a probe the node does not have, with no age", () => {
    const german = blockOf(lines, "german");
    expect(cells(german[0])).toEqual(["! german", "down", "-", "-", "-", "-"]);
    expect(cells(german[1])).toEqual(["2m"]);
    expect(german[2]).toBe(
      "  not reachable from any region, the control group included",
    );
  });

  it("keeps stale values on show, with their age and one reason per quiet probe", () => {
    const hector = blockOf(lines, "hector");
    expect(cells(hector[0])).toEqual([
      "! hector",
      "down",
      "1%",
      "35%",
      "96%",
      "443",
    ]);
    expect(cells(hector[1])).toEqual(["15m", "5m", "5m", "5m", "5m"]);
    // The old `down` and the disk past its bound are shown, not argued
    // about: the reasons are about the silence, the values speak for
    // themselves, in colour where there is any.
    expect(hector[2]).toBe("  system last reported 5m ago, expected every 1m");
    expect(hector[3]).toBe(
      "  reachability last reported 15m ago, expected every 5m",
    );
  });

  it("gives a node that never reported dashes, no age line, and its reasons", () => {
    const patroclus = blockOf(lines, "patroclus");
    expect(cells(patroclus[0])).toEqual([
      "! patroclus",
      "-",
      "-",
      "-",
      "-",
      "-",
    ]);
    expect(patroclus.slice(1)).toEqual([
      "  system has not reported yet",
      "  reachability has not reported yet",
    ]);
    expect(lines).toHaveLength(16);
  });

  it("lines every column up under its header, ages included", () => {
    const header = lines[0] ?? "";
    const starts = ["NODE", "REACH", "LOAD", "MEM", "DISK", "PORTS"].map(
      (title) => header.indexOf(title),
    );

    // Every cell on a value or age line begins where its header does. A
    // cell may hold single spaces ("missing 443"); two spaces end it.
    for (const row of lines.slice(1).filter((line) => !line.startsWith("  "))) {
      for (const cell of row.matchAll(/\S+(?: \S+)*/g)) {
        expect(starts).toContain(cell.index);
      }
    }
    const ageLines = ["achilles", "antilochus", "german", "hector"].map(
      (name) => blockOf(lines, name)[1],
    );
    for (const row of ageLines) {
      for (const cell of (row ?? "").matchAll(/\S+/g)) {
        expect(starts).toContain(cell.index);
      }
    }
  });

  it("never ends a line in spaces", () => {
    for (const line of lines) expect(line).toBe(line.trimEnd());
  });

  it("draws a probe's columns only when some node has the probe", () => {
    const noReachability = frame(
      stateOf(
        { ...FLEET, probes: { reachability: { enabled: false } } },
        FLEET_POINTS,
      ),
      false,
    );

    expect(cells(noReachability.split("\n")[0])).toEqual([
      "NODE",
      "LOAD",
      "MEM",
      "DISK",
      "PORTS",
    ]);
    expect(noReachability).not.toContain("REACH");
  });

  it("paints the value by what it says, the age by its staleness, the name by the node", () => {
    const coloured = frame(stateOf(FLEET, FLEET_POINTS), true);
    const colouredLines = coloured.split("\n");

    const block = (name: string) => blockOf(colouredLines, name);
    expect(block("achilles").join("\n")).not.toContain("\u001b");
    // A fresh problem: the name and the value in the tint of the problem,
    // the age plain — it is not the age that is wrong.
    const antilochus = block("antilochus");
    expect(spans(antilochus[0])).toEqual([
      ["33", "! antilochus"],
      ["33", "missing 443"],
    ]);
    expect(antilochus[1]).not.toContain("\u001b");
    expect(spans(antilochus[2])).toEqual([
      ["2", "  system.ports reports a problem"],
    ]);
    const german = block("german");
    expect(spans(german[0])).toEqual([
      ["31", "! german"],
      ["31", "down"],
    ]);
    expect(german[1]).not.toContain("\u001b");
    // Stale: the name says the node went quiet, each value keeps the tint
    // of what it said — `down` and a disk past its critical bound red, the
    // rest plain — and every stale age is yellow: how old, not how bad.
    const hector = block("hector");
    expect(spans(hector[0])).toEqual([
      ["33", "! hector"],
      ["31", "down"],
      ["31", "96%"],
    ]);
    expect(spans(hector[1])).toEqual([
      ["33", "15m"],
      ["33", "5m"],
      ["33", "5m"],
      ["33", "5m"],
      ["33", "5m"],
    ]);
    expect(spans(block("patroclus")[0])).toEqual([["2", "! patroclus"]]);
    // The escape codes are the only difference: the columns line up the
    // same, and stripping them gives the plain table back.
    expect(stripped(coloured)).toBe(plain);
  });

  // The one-shot path `status` uses: its own stream, one frame, no cursor
  // movement — and the same frame the testing library sees.
  it("is what frameOf prints for a one-shot command, at the width it asks for", async () => {
    const state = stateOf(FLEET, FLEET_POINTS);
    const width = statusTableWidth(state);

    // The width is the longest line and not a character more: ink lays
    // out a cell per column per line, and a fleet pays for every spare one.
    expect(width).toBe(Math.max(...lines.map((line) => line.length)));
    await expect(
      frameOf(<StatusTable state={state} colour={false} />, width),
    ).resolves.toBe(plain);
  });

  // No nodes is a valid answer, not an error: the header alone, as wide as
  // its one column. Built by hand — there is no fleet to build it from.
  it("draws an empty fleet as the header alone", async () => {
    const empty: StateResponse = { now: NOW, nodes: [] };

    expect(frame(empty, false)).toBe("NODE");
    expect(statusTableWidth(empty)).toBe("NODE".length);
    await expect(
      frameOf(<StatusTable state={empty} colour={false} />, "NODE".length),
    ).resolves.toBe("NODE");
  });

  // Ink catches a throw in a component and draws an error overview in its
  // place; printed as data with exit 0, that would be a wrong answer
  // dressed as a complete one. The command must fail instead.
  it("fails loudly through frameOf when the component throws", async () => {
    const Broken = (): ReactElement => {
      throw new Error("a bug in the table");
    };

    await expect(frameOf(<Broken />, 80)).rejects.toThrow("a bug in the table");
  });
});

describe("StatusTable in a window narrower than the table", () => {
  // `watch` draws at the window's width: cells must neither shrink nor
  // wrap, or the header stacks letter by letter; the right edge is cut.
  it("keeps every line on one row, cut at the window's edge", async () => {
    const state = stateOf(FLEET, FLEET_POINTS);
    const wide = frame(state, false).split("\n");
    const narrow = (
      await frameOf(<StatusTable state={state} colour={false} />, 40)
    ).split("\n");

    expect(statusTableWidth(state)).toBeGreaterThan(40);
    // Table lines are the wide ones cut at 40, no ellipsis, none added;
    // reasons wrap, so only the lines before the first reason compare.
    const tableLines = wide.findIndex((line) => line.startsWith("  "));
    expect(narrow.slice(0, tableLines)).toEqual(
      wide.slice(0, tableLines).map((line) => line.slice(0, 40).trimEnd()),
    );
    for (const line of narrow) expect(line.length).toBeLessThanOrEqual(40);
  });
});

describe("StatusTable with an acknowledgement", () => {
  const known: Acknowledgement = {
    node: "antilochus",
    since: at(2 * 3600),
    status: "warn",
    untilOk: false,
    note: "443 moved to a sidecar",
  };

  const linesWith = (acknowledgement: Acknowledgement): string[] =>
    frame(stateOf(FLEET, FLEET_POINTS, [acknowledgement]), false).split("\n");

  it("says so under the ages and above the reasons, the node still marked", () => {
    const lines = linesWith(known);

    const antilochus = blockOf(lines, "antilochus");
    expect(cells(antilochus[0])[0]).toBe("! antilochus");
    expect(antilochus[2]).toBe("  acknowledged 2h ago: 443 moved to a sidecar");
    expect(antilochus[3]).toBe("  system.ports reports a problem");
  });

  it("names the sticky kind and the time left, and drops an absent note", () => {
    const lines = linesWith({
      node: "antilochus",
      since: at(2 * 3600),
      until: NOW + 3 * 86_400,
      status: "warn",
      untilOk: true,
    });

    expect(blockOf(lines, "antilochus")[2]).toBe(
      "  acknowledged 2h ago, until ok, 3d left",
    );
  });

  it("gives the time left of the default kind without naming a kind", () => {
    const lines = linesWith({
      node: "antilochus",
      since: at(2 * 3600),
      until: NOW + 3 * 86_400,
      status: "warn",
      untilOk: false,
    });

    expect(blockOf(lines, "antilochus")[2]).toBe(
      "  acknowledged 2h ago, 3d left",
    );
  });

  it("adds one line to the acknowledged node and none to the others", () => {
    const without = frame(stateOf(FLEET, FLEET_POINTS), false).split("\n");
    const lines = linesWith(known);

    expect(lines).toHaveLength(without.length + 1);
    expect(lines.filter((line) => line.includes("acknowledged"))).toHaveLength(
      1,
    );
  });

  it("is the same text in colour, not dimmed like the reasons", () => {
    const coloured = frame(stateOf(FLEET, FLEET_POINTS, [known]), true).split(
      "\n",
    );

    const antilochus = blockOf(coloured, "antilochus");
    expect(antilochus[2]).toBe("  acknowledged 2h ago: 443 moved to a sidecar");
    expect(spans(antilochus[3]).map(([code]) => code)).toEqual(["2"]);
  });

  it("widens a one-shot table to a long note, drawn whole", async () => {
    const note = "n".repeat(200);
    const state = stateOf(FLEET, FLEET_POINTS, [{ ...known, note }]);
    const width = statusTableWidth(state);

    expect(width).toBe("  acknowledged 2h ago: ".length + note.length);
    const drawn = await frameOf(
      <StatusTable state={state} colour={false} />,
      width,
    );
    expect(drawn.split("\n")).toContain(`  acknowledged 2h ago: ${note}`);
  });

  // `watch` draws at the window's width: the line wraps, as reasons do.
  it("wraps a long note inside a narrow window", async () => {
    const note = "a long note ".repeat(10).trim();
    const state = stateOf(FLEET, FLEET_POINTS, [{ ...known, note }]);
    const narrow = (
      await frameOf(<StatusTable state={state} colour={false} />, 40)
    ).split("\n");

    for (const line of narrow) expect(line.length).toBeLessThanOrEqual(40);
    expect(narrow.join(" ").replace(/\s+/g, " ")).toContain(
      `acknowledged 2h ago: ${note}`,
    );
  });
});

describe("StatusTable's PORTS column", () => {
  const portsCell = (meta: Record<string, unknown>, ok = true): string => {
    const points = systemPoints("achilles", at(30), {
      load: 1,
      mem: 1,
      disk: 1,
    }).map((point) =>
      point.metric === "system.ports" ? { ...point, ok, meta } : point,
    );
    const config = {
      nodes: [{ name: "achilles", host: "203.0.113.10", ssh: "achilles" }],
    };
    const lines = frame(stateOf(config, points), false).split("\n");

    return cells(lines[1]).at(-1) ?? "";
  };

  // No `ports` in the config: nothing to compare, the list is for reference.
  it("lists what listens when nothing is wrong", () => {
    expect(
      portsCell({ listening: [443, 2222, 3948], undeclared: [], missing: [] }),
    ).toBe("443, 2222, 3948");
  });

  it("names what is wrong instead of the list, missing first", () => {
    expect(
      portsCell(
        { listening: [2222, 3948], undeclared: [3948], missing: ["443"] },
        false,
      ),
    ).toBe("missing 443");
    expect(
      portsCell(
        { listening: [443, 2222, 3948], undeclared: [2222, 3948], missing: [] },
        false,
      ),
    ).toBe("extra 2222, 3948");
  });

  it("says unreadable when the node could not list its ports", () => {
    expect(
      portsCell({ unreadable: "ss is missing or failed on the node" }, false),
    ).toBe("unreadable");
  });

  it("says none when nothing listens", () => {
    expect(portsCell({ listening: [], undeclared: [], missing: [] })).toBe(
      "none",
    );
  });

  it("says ok for a reading that carries no list", () => {
    expect(portsCell({})).toBe("ok");
  });
});

describe("nodeHeights", () => {
  // Words of every length, an unbreakable run, a note: what ink must wrap.
  const wordy: Acknowledgement = {
    node: "antilochus",
    since: at(2 * 3600),
    status: "warn",
    untilOk: false,
    note: "443 moved to a sidecar while the provider rotates the address pool",
  };
  const points: MetricPoint[] = [
    ...FLEET_POINTS,
    {
      ts: at(30),
      node: "patroclus",
      metric: "system.up",
      ok: false,
      meta: {
        errorKind: "unreachable",
        detail: `kex_exchange_identification: ${"x".repeat(70)} read: Connection reset by peer`,
      },
    },
  ];
  const state = stateOf(FLEET, points, [wordy]);

  // The property `watch` relies on: what it counts is what ink draws.
  it.each([24, 37, 50, 80, 120])(
    "counts the lines ink draws at %i columns",
    async (columns) => {
      const drawn = (
        await frameOf(<StatusTable state={state} colour={false} />, columns)
      ).split("\n");
      const heights = nodeHeights(state, columns);

      expect(heights.map((each) => each.node)).toEqual([
        "german",
        "hector",
        "antilochus",
        "patroclus",
        "achilles",
      ]);
      expect(1 + heights.reduce((sum, each) => sum + each.height, 0)).toBe(
        drawn.length,
      );
      // Each node starts exactly where the heights before it say: a
      // wrapped reason may start a line without a space, so no guessing.
      let line = 1;
      for (const { node, height } of heights) {
        expect(drawn[line]?.replace(/^! /, "").split(" ")[0]).toBe(node);
        line += height;
      }
    },
  );

  it("draws only the nodes asked for, with the whole fleet's widths", () => {
    const all = frame(state, false).split("\n");
    const some = render(
      <StatusTable
        state={state}
        colour={false}
        visible={{ first: 1, count: 2 }}
      />,
    )
      .lastFrame()
      ?.split("\n");

    expect(some?.[0]).toBe(all[0]);
    expect(some?.slice(1)).toEqual([
      ...blockOf(all, "hector"),
      ...blockOf(all, "antilochus"),
    ]);
  });
});
