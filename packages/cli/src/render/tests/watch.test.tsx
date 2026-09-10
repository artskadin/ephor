import type { StateResponse } from "@ephorate/core";
import { cleanup, render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { Watch, type WatchSource } from "../watch";

// Unmounted after each test, or its poll chain runs on into the next.
afterEach(cleanup);

const NOW_MS = 1_800_000_000_000;

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
function sourceOf(...answers: (StateResponse | Error)[]): WatchSource & {
  calls: number;
} {
  const source = {
    apiUrl: "http://127.0.0.1:31556",
    calls: 0,
    state(): Promise<StateResponse> {
      const answer = answers[Math.min(source.calls, answers.length - 1)];
      source.calls += 1;

      if (answer === undefined) throw new Error("no answers given");

      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
  };

  return source;
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;

  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Watch", () => {
  it("draws the initial state with the footer, then the next answer", async () => {
    const source = sourceOf(stateOf("warn"));
    const { lastFrame } = render(
      <Watch
        source={source}
        initial={stateOf("ok")}
        intervalMs={10}
        colour={false}
        now={() => NOW_MS}
      />,
    );

    expect(lastFrame()).toContain("achilles");
    expect(lastFrame()).not.toContain("! achilles");
    expect(lastFrame()).toMatch(
      /http:\/\/127\.0\.0\.1:31556 · updated \d\d:\d\d:\d\d · q to quit/,
    );

    await until(() => lastFrame()?.includes("! achilles") ?? false);
    expect(lastFrame()).toContain("achilles is warn");
  });

  it("keeps the last table through an outage and says since when", async () => {
    const source = sourceOf(
      stateOf("warn"),
      new Error("cannot reach the collector"),
    );
    const { lastFrame } = render(
      <Watch
        source={source}
        initial={stateOf("ok")}
        intervalMs={10}
        colour={false}
        now={() => NOW_MS}
      />,
    );

    await until(() => source.calls >= 3);

    expect(lastFrame()).toContain("! achilles");
    expect(lastFrame()).toMatch(
      /^unreachable since \d\d:\d\d:\d\d, last update \d\d:\d\d:\d\d: cannot reach the collector$/m,
    );
  });

  it("recovers after an outage and keeps polling", async () => {
    const source = sourceOf(new Error("gone"), stateOf("warn"));
    const { lastFrame } = render(
      <Watch
        source={source}
        initial={stateOf("ok")}
        intervalMs={10}
        colour={false}
        now={() => NOW_MS}
      />,
    );

    await until(() => lastFrame()?.includes("unreachable") ?? false);
    await until(() => lastFrame()?.includes("! achilles") ?? false);

    expect(lastFrame()).not.toContain("unreachable");
    expect(lastFrame()).toContain("q to quit");
  });

  it("stops polling once unmounted", async () => {
    const source = sourceOf(stateOf("ok"));
    const { unmount } = render(
      <Watch
        source={source}
        initial={stateOf("ok")}
        intervalMs={10}
        colour={false}
        now={() => NOW_MS}
      />,
    );

    await until(() => source.calls >= 2);
    unmount();
    const callsAtUnmount = source.calls;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(source.calls).toBe(callsAtUnmount);
  });
});
