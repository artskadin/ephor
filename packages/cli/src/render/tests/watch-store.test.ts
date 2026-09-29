import type { NodeState, StateResponse } from "@ephorate/core";
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

function storeOf(
  source: WatchSource,
  tick = () => NOW_MS,
  notify?: (title: string, body: string) => Promise<void>,
  notifyOn: "warn" | "critical" = "warn",
): WatchStore {
  const store = new WatchStore({
    source,
    initial: stateOf("ok"),
    intervalMs: 10,
    now: tick,
    notify,
    notifyOn,
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

  it("sends one notification per status change, none for a repeat", async () => {
    const sent: [string, string][] = [];
    const source = sourceOf(stateOf("warn"));
    const store = storeOf(
      source,
      () => NOW_MS,
      async (title, body) => {
        sent.push([title, body]);
      },
    );

    await until(() => source.calls >= 4);

    expect(sent).toEqual([["ephor: achilles", "ok → warn · achilles is warn"]]);
    expect(store.read().notificationsFailed).toBeUndefined();
  });

  it("switches notifications off after the first failure, saying why", async () => {
    let attempts = 0;
    const source = sourceOf(stateOf("warn"), stateOf("ok"), stateOf("warn"));
    const store = storeOf(
      source,
      () => NOW_MS,
      async () => {
        attempts += 1;
        throw new Error("spawn notify-send ENOENT");
      },
    );

    await until(() => store.read().notificationsFailed !== undefined);
    await until(() => source.calls >= 5);

    expect(attempts).toBe(1);
    expect(store.read().notificationsFailed).toBe("spawn notify-send ENOENT");
  });

  it("at critical, keeps quiet about ok → warn", async () => {
    const sent: string[] = [];
    const source = sourceOf(stateOf("warn"));
    storeOf(
      source,
      () => NOW_MS,
      async (title) => {
        sent.push(title);
      },
      "critical",
    );

    await until(() => source.calls >= 4);

    expect(sent).toEqual([]);
  });

  // With the collector gone no node can turn stale in `watch`: the loss
  // and the return are news of their own, at any level.
  it("says when the collector goes silent and when it answers again", async () => {
    const sent: [string, string][] = [];
    const source = sourceOf(
      new Error("cannot reach the collector at http://127.0.0.1:31556"),
      new Error("still gone"),
      stateOf("ok"),
    );
    storeOf(
      source,
      () => NOW_MS,
      async (title, body) => {
        sent.push([title, body]);
      },
      "critical",
    );

    await until(() => sent.length >= 2);

    expect(sent[0]).toEqual([
      "ephor: collector unreachable",
      "cannot reach the collector at http://127.0.0.1:31556",
    ]);
    expect(sent[1]?.[0]).toBe("ephor: collector back");
    expect(sent[1]?.[1]).toMatch(
      /^http:\/\/127\.0\.0\.1:31556 answers again, silent since \d\d:\d\d:\d\d$/,
    );
    expect(sent).toHaveLength(2);
  });

  // Eight nodes change, two of them into critical: at `critical` that is
  // two notifications of their own, not "8 nodes changed".
  it("counts the summary after the level's filter", async () => {
    const sent: string[] = [];
    const node = stateOf("ok").nodes[0] as NodeState;
    const initial: StateResponse = {
      ...stateOf("ok"),
      nodes: Array.from({ length: 8 }, (_, index) => ({
        ...node,
        node: `node-${index}`,
      })),
    };
    const next: StateResponse = {
      ...initial,
      nodes: initial.nodes.map((each, index) => ({
        ...each,
        status: index < 2 ? "critical" : "warn",
      })),
    };
    const source = sourceOf(next);
    const store = new WatchStore({
      source,
      initial,
      intervalMs: 10,
      now: () => NOW_MS,
      notify: async (title) => {
        sent.push(title);
      },
      notifyOn: "critical",
    });
    stores.push(store);
    store.start();

    await until(() => source.calls >= 3);

    expect(sent).toEqual(["ephor: node-0", "ephor: node-1"]);
  });
});
