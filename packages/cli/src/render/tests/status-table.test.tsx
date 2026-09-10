import {
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
import { StatusTable, statusTableWidth } from "../status-table";

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
): StateResponse {
  const parsed = parseConfig(config, PROBES);

  return {
    now: NOW,
    nodes: buildNodeState({
      nodes: resolveConfig(parsed, PROBES),
      points,
      now: NOW,
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
    expect(cells(lines[1])).toEqual([
      "achilles",
      "ok",
      "3%",
      "41%",
      "62%",
      "ok",
    ]);
    expect(cells(lines[2])).toEqual(["1m", "30s", "30s", "30s", "30s"]);
  });

  it("marks a node that is not ok, and says why under it", () => {
    expect(cells(lines[3])).toEqual([
      "! antilochus",
      "ok",
      "2%",
      "40%",
      "87%",
      "missing 443",
    ]);
    expect(cells(lines[4])).toEqual(["1m", "30s", "30s", "30s", "30s"]);
    expect(lines[5]).toBe("  system.ports reports a problem");
  });

  it("dashes the columns of a probe the node does not have, with no age", () => {
    expect(cells(lines[6])).toEqual(["! german", "down", "-", "-", "-", "-"]);
    expect(cells(lines[7])).toEqual(["2m"]);
    expect(lines[8]).toBe(
      "  not reachable from any region, the control group included",
    );
  });

  it("keeps stale values on show, with their age and one reason per quiet probe", () => {
    expect(cells(lines[9])).toEqual([
      "! hector",
      "down",
      "1%",
      "35%",
      "96%",
      "ok",
    ]);
    expect(cells(lines[10])).toEqual(["15m", "5m", "5m", "5m", "5m"]);
    // The old `down` and the disk past its bound are shown, not argued
    // about: the reasons are about the silence, the values speak for
    // themselves, in colour where there is any.
    expect(lines[11]).toBe("  system last reported 5m ago, expected every 1m");
    expect(lines[12]).toBe(
      "  reachability last reported 15m ago, expected every 5m",
    );
  });

  it("gives a node that never reported dashes, no age line, and its reasons", () => {
    expect(cells(lines[13])).toEqual(["! patroclus", "-", "-", "-", "-", "-"]);
    expect(lines[14]).toBe("  system has not reported yet");
    expect(lines[15]).toBe("  reachability has not reported yet");
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
    for (const row of [lines[2], lines[4], lines[7], lines[10]]) {
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

    expect(colouredLines[1]).not.toContain("\u001b");
    expect(colouredLines[2]).not.toContain("\u001b");
    // A fresh problem: the name and the value in the tint of the problem,
    // the age plain — it is not the age that is wrong.
    expect(spans(colouredLines[3])).toEqual([
      ["33", "! antilochus"],
      ["33", "missing 443"],
    ]);
    expect(colouredLines[4]).not.toContain("\u001b");
    expect(spans(colouredLines[5])).toEqual([
      ["2", "  system.ports reports a problem"],
    ]);
    expect(spans(colouredLines[6])).toEqual([
      ["31", "! german"],
      ["31", "down"],
    ]);
    expect(colouredLines[7]).not.toContain("\u001b");
    // Stale: the name says the node went quiet, each value keeps the tint
    // of what it said — `down` and a disk past its critical bound red, the
    // rest plain — and every stale age is yellow: how old, not how bad.
    expect(spans(colouredLines[9])).toEqual([
      ["33", "! hector"],
      ["31", "down"],
      ["31", "96%"],
    ]);
    expect(spans(colouredLines[10])).toEqual([
      ["33", "15m"],
      ["33", "5m"],
      ["33", "5m"],
      ["33", "5m"],
      ["33", "5m"],
    ]);
    expect(spans(colouredLines[13])).toEqual([["2", "! patroclus"]]);
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
