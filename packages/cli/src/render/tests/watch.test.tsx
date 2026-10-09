import type { StateResponse } from "@ephorate/core";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { Scroll } from "../scroll";
import { Watch } from "../watch";
import { type WatchSource, WatchStore } from "../watch-store";

const NOW_MS = 1_800_000_000_000;
const stores: WatchStore[] = [];

afterEach(() => {
  cleanup();
  for (const store of stores.splice(0)) store.stop();
});

function stateOf(status: "ok" | "warn"): StateResponse {
  return {
    now: NOW_MS / 1000,
    nodes: [
      {
        node: "achilles",
        status,
        reachability: "ok",
        probes: ["reachability"],
        metrics: [],
        reasons: status === "ok" ? [] : ["achilles is warn"],
      },
    ],
  };
}

/** Answers in order; the last answer repeats. A rejection is an outage. */
function sourceOf(...answers: (StateResponse | Error)[]): WatchSource {
  let calls = 0;

  return {
    apiUrl: "http://127.0.0.1:31556",
    state(): Promise<StateResponse> {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;

      if (answer === undefined) throw new Error("no answers given");

      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
  };
}

/** ink-testing-library's stream is 100 columns wide; the rows are ours. */
function watching(
  source: WatchSource,
  onQuit: () => void = () => undefined,
  notifyOn: "warn" | "critical" | undefined = "warn",
  initial: StateResponse = stateOf("ok"),
  rows = 40,
): ReturnType<typeof render> {
  const store = new WatchStore({
    source,
    initial,
    intervalMs: 10,
    now: () => NOW_MS,
  });
  stores.push(store);
  store.start();

  return render(
    <Watch
      store={store}
      apiUrl={source.apiUrl}
      colour={false}
      notifyOn={notifyOn}
      scroll={new Scroll()}
      columns={100}
      rows={rows}
      onQuit={onQuit}
    />,
  );
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;

  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Watch", () => {
  // An upgrade with serve left running: the footer says so, in its own
  // lines, and the frame still fits the window.
  it("says below when the collector runs another ephor", () => {
    const older = { ...stateOf("ok"), version: "0.0.0-older" };
    const { lastFrame } = watching(
      sourceOf(older),
      undefined,
      "warn",
      older,
      12,
    );
    const frame = lastFrame() ?? "";
    const words = frame.replace(/\s+/g, " ");

    expect(words).toContain(
      "warning: the ephor serve here runs ephor 0.0.0-older, this command",
    );
    expect(words).toContain("restart it to run this one:");
    expect(frame.split("\n").length).toBeLessThan(12);
  });

  it("draws the store's state with the footer, and follows its updates", async () => {
    const { lastFrame } = watching(sourceOf(stateOf("warn")));

    expect(lastFrame()).toContain("achilles");
    expect(lastFrame()).not.toContain("! achilles");
    expect(lastFrame()?.replace(/\s+/g, " ")).toMatch(
      /nodes 1–1 of 1 · all ok · collector at http:\/\/127\.0\.0\.1:31556 · updated \d\d:\d\d:\d\d · q to quit/,
    );

    await until(() => lastFrame()?.includes("! achilles") ?? false);
    expect(lastFrame()).toContain("achilles is warn");
  });

  it("says since when the collector is unreachable, a blank line below the table", async () => {
    const { lastFrame } = watching(
      sourceOf(stateOf("warn"), new Error("cannot reach the collector")),
    );

    await until(() => lastFrame()?.includes("unreachable") ?? false);

    expect(lastFrame()).toContain("! achilles");
    expect(lastFrame()).toMatch(/achilles is warn\n\nnodes 1–1 of 1/);
    // ink wraps the footer at the window's width: joined back for the match.
    const footer = lastFrame()?.split("\n\n")[1]?.replace(/\s+/g, " ");
    expect(footer).toMatch(
      /^nodes 1–1 of 1 · 1 warn · collector at http:\/\/127\.0\.0\.1:31556 unreachable since \d\d:\d\d:\d\d, last update \d\d:\d\d:\d\d: cannot reach the collector$/,
    );
  });

  it.each([
    ["q", "q"],
    ["Ctrl-C", "\u0003"],
  ])("asks to quit on %s", async (_name, key) => {
    let quits = 0;
    const { stdin } = watching(sourceOf(stateOf("ok")), () => {
      quits += 1;
    });

    // ink attaches its key listener after the first render.
    await new Promise((resolve) => setTimeout(resolve, 20));
    stdin.write(key);
    await until(() => quits === 1);
  });

  it("says in the footer when only critical and stale changes notify", () => {
    const quiet = watching(sourceOf(stateOf("ok")));
    const critical = watching(sourceOf(stateOf("ok")), undefined, "critical");

    expect(quiet.lastFrame()).not.toContain("notify:");
    expect(critical.lastFrame()?.replace(/\s+/g, " ")).toContain(
      "notify: critical and stale only",
    );
  });
});

describe("Watch over a fleet taller than the window", () => {
  /** Thirty nodes with no readings, each one line and one reason. */
  const fleet: StateResponse = {
    now: NOW_MS / 1000,
    nodes: Array.from({ length: 30 }, (_, index) => ({
      node: `node-${String(index).padStart(2, "0")}`,
      status: index < 2 ? ("critical" as const) : ("warn" as const),
      reachability: "ok" as const,
      probes: ["reachability"],
      metrics: [],
      reasons: [`reason ${index}`],
    })),
  };

  const ROWS = 15;

  const nodesIn = (frame: string | undefined): string[] =>
    (frame ?? "").match(/node-\d\d/g) ?? [];

  it("draws only what fits, below the window, and says which", () => {
    const { lastFrame } = watching(
      sourceOf(fleet),
      undefined,
      "warn",
      fleet,
      ROWS,
    );
    const frame = lastFrame() ?? "";

    // 15 rows: the header, five nodes of two lines, a blank, a footer of
    // two lines at 100 columns: 14, one short of the window.
    expect(nodesIn(frame)).toEqual([
      "node-00",
      "node-01",
      "node-02",
      "node-03",
      "node-04",
    ]);
    expect(frame.split("\n")).toHaveLength(ROWS - 1);
    expect(frame.replace(/\s+/g, " ")).toContain(
      "nodes 1–5 of 30 · 2 critical, 28 warn · ↑↓ PgUp PgDn",
    );
  });

  // Below the window by one line at most: one more node would not fit,
  // and a frame as tall as the window makes ink wipe the screen.
  it.each([9, 12, 15, 16, 21])(
    "fills %i rows to one line short, never more",
    (rows) => {
      const lines = (
        watching(sourceOf(fleet), undefined, "warn", fleet, rows).lastFrame() ??
        ""
      ).split("\n");

      expect(lines.length).toBeLessThan(rows);
      expect(lines.length + 2).toBeGreaterThanOrEqual(rows);
    },
  );

  // Twenty reasons into nine rows: drawn alone, cut, the footer in place.
  it("cuts a node taller than the window, and keeps below it", () => {
    const tall: StateResponse = {
      ...fleet,
      nodes: [
        {
          ...(fleet.nodes[0] as StateResponse["nodes"][number]),
          reasons: Array.from({ length: 20 }, (_, index) => `reason ${index}`),
        },
      ],
    };
    const lines = (
      watching(sourceOf(tall), undefined, "warn", tall, 9).lastFrame() ?? ""
    ).split("\n");

    expect(lines.length).toBeLessThan(9);
    expect(lines[1]).toMatch(/node-00/);
    expect(lines.join(" ")).toContain("nodes 1–1 of 1");
  });

  it("scrolls by a node, a page, and to either end", async () => {
    const { lastFrame, stdin } = watching(
      sourceOf(fleet),
      undefined,
      "warn",
      fleet,
      ROWS,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const after = async (key: string, first: string) => {
      stdin.write(key);
      await until(() => nodesIn(lastFrame())[0] === first);
    };

    await after("j", "node-01");
    await after("\u001b[B", "node-02");
    await after("k", "node-01");
    await after("\u001b[6~", "node-06");
    await after("\u001b[5~", "node-01");
    await after("G", "node-25");
    expect(nodesIn(lastFrame())).toEqual([
      "node-25",
      "node-26",
      "node-27",
      "node-28",
      "node-29",
    ]);
    await after("g", "node-00");
  });
});
