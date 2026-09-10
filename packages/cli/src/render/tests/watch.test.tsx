import type { StateResponse } from "@ephorate/core";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
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

function watching(
  source: WatchSource,
  onQuit: () => void = () => undefined,
): ReturnType<typeof render> {
  const store = new WatchStore({
    source,
    initial: stateOf("ok"),
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
  it("draws the store's state with the footer, and follows its updates", async () => {
    const { lastFrame } = watching(sourceOf(stateOf("warn")));

    expect(lastFrame()).toContain("achilles");
    expect(lastFrame()).not.toContain("! achilles");
    expect(lastFrame()).toMatch(
      /collector at http:\/\/127\.0\.0\.1:31556 · updated \d\d:\d\d:\d\d · q to quit/,
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
    expect(lastFrame()).toMatch(/achilles is warn\n\ncollector at/);
    // ink wraps the footer at the window's width: joined back for the match.
    const footer = lastFrame()?.split("\n\n")[1]?.replace(/\s+/g, " ");
    expect(footer).toMatch(
      /^collector at http:\/\/127\.0\.0\.1:31556 unreachable since \d\d:\d\d:\d\d, last update \d\d:\d\d:\d\d: cannot reach the collector$/,
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
});
