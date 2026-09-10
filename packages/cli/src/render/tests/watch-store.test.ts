import type { StateResponse } from "@ephorate/core";
import { afterEach, describe, expect, it } from "vitest";
import { type WatchSource, WatchStore } from "../watch-store";

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

const stores: WatchStore[] = [];

function storeOf(source: WatchSource, tick = () => NOW_MS): WatchStore {
  const store = new WatchStore({
    source,
    initial: stateOf("ok"),
    intervalMs: 10,
    now: tick,
  });
  stores.push(store);
  store.start();

  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.stop();
});

describe("WatchStore", () => {
  it("starts from the initial state and takes each poll's answer", async () => {
    const source = sourceOf(stateOf("warn"));
    const store = storeOf(source);

    expect(store.read().state.nodes[0]?.status).toBe("ok");
    await until(() => store.read().state.nodes[0]?.status === "warn");
    expect(store.read().outage).toBeUndefined();
  });

  it("keeps the last state through an outage, dated from its first failure", async () => {
    let clock = NOW_MS;
    const source = sourceOf(stateOf("warn"), new Error("gone"));
    const store = storeOf(source, () => clock);

    await until(() => store.read().state.nodes[0]?.status === "warn");
    clock += 1000;
    await until(() => store.read().outage !== undefined);
    const first = store.read().outage;
    clock += 1000;
    await until(() => source.calls >= 5);

    expect(store.read().state.nodes[0]?.status).toBe("warn");
    expect(store.read().outage).toEqual(first);
    expect(first).toEqual({ sinceMs: NOW_MS + 1000, message: "gone" });
    expect(store.read().updatedMs).toBe(NOW_MS);
  });

  it("clears the outage on the next good answer", async () => {
    const source = sourceOf(new Error("gone"), stateOf("warn"));
    const store = storeOf(source);

    await until(() => store.read().outage !== undefined);
    await until(() => store.read().outage === undefined);
    expect(store.read().state.nodes[0]?.status).toBe("warn");
  });

  it("notifies subscribers on each poll, and no more after stop()", async () => {
    const source = sourceOf(stateOf("warn"));
    const store = storeOf(source);
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });

    await until(() => notified >= 2);
    store.stop();
    const callsAtStop = source.calls;
    const notifiedAtStop = notified;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(source.calls).toBe(callsAtStop);
    expect(notified).toBe(notifiedAtStop);
  });
});
