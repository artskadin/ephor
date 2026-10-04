import type { MetricStatus, NodeState, StateResponse } from "@ephorate/core";
import { describe, expect, it } from "vitest";
import {
  describeTransition,
  isWorthNotifying,
  SUMMARY_FROM,
  summarizeTransitions,
  type Transition,
  transitionsBetween,
} from "../transitions";

function node(
  name: string,
  status: MetricStatus,
  ...reasons: string[]
): NodeState {
  return {
    node: name,
    status,
    reachability: "ok",
    probes: ["reachability"],
    metrics: [],
    reasons,
  };
}

function stateOf(...nodes: NodeState[]): StateResponse {
  return { now: 1_800_000_000, nodes };
}

describe("transitionsBetween", () => {
  it("reports each node whose status changed, with its first reason", () => {
    const before = stateOf(node("achilles", "ok"), node("german", "critical"));
    const after = stateOf(
      node("achilles", "warn", "system.ports reports a problem", "second"),
      node("german", "critical", "still down"),
    );

    expect(transitionsBetween(before, after)).toEqual([
      {
        node: "achilles",
        from: "ok",
        to: "warn",
        reason: "system.ports reports a problem",
        acknowledged: false,
      },
    ]);
  });

  it("reports recoveries, with no reason to give", () => {
    expect(
      transitionsBetween(
        stateOf(node("german", "critical", "not reachable")),
        stateOf(node("german", "ok")),
      ),
    ).toEqual([
      {
        node: "german",
        from: "critical",
        to: "ok",
        reason: undefined,
        acknowledged: false,
      },
    ]);
  });

  it("treats a node appearing or disappearing as a transition", () => {
    expect(
      transitionsBetween(
        stateOf(node("achilles", "ok")),
        stateOf(node("hector", "ok")),
      ),
    ).toEqual([
      {
        node: "achilles",
        from: "ok",
        to: "absent",
        reason: undefined,
        acknowledged: false,
      },
      {
        node: "hector",
        from: "absent",
        to: "ok",
        reason: undefined,
        acknowledged: false,
      },
    ]);
  });

  it("finds nothing between two equal answers", () => {
    const state = stateOf(node("achilles", "warn", "a reason"));

    expect(transitionsBetween(state, state)).toEqual([]);
  });
});

describe("describeTransition", () => {
  it("names the node in the title and the change in the body", () => {
    expect(
      describeTransition({
        node: "german",
        from: "stale",
        to: "critical",
        reason: "not reachable from any region",
        acknowledged: false,
      }),
    ).toEqual({
      title: "ephor: german",
      body: "stale → critical · not reachable from any region",
    });
  });

  it("says when a node is new or gone instead of a status pair", () => {
    expect(
      describeTransition({
        node: "hector",
        from: "absent",
        to: "ok",
        reason: undefined,
        acknowledged: false,
      }).body,
    ).toBe("new node, ok");
    expect(
      describeTransition({
        node: "hector",
        from: "ok",
        to: "absent",
        reason: undefined,
        acknowledged: false,
      }).body,
    ).toBe("gone from the collector");
  });
});

describe("summarizeTransitions", () => {
  it("counts the new statuses, worst first", () => {
    const transitions = Array.from(
      { length: SUMMARY_FROM + 6 },
      (_, index) => ({
        node: `node-${index}`,
        from: "stale" as const,
        to: (index < 3 ? "critical" : index < 5 ? "absent" : "ok") as
          | "critical"
          | "absent"
          | "ok",
        reason: undefined,
        acknowledged: false,
      }),
    );

    expect(summarizeTransitions(transitions)).toEqual({
      title: "ephor: 12 nodes changed",
      body: "3 critical, 7 ok, 2 gone",
    });
  });
});

describe("isWorthNotifying", () => {
  const change = (
    from: Transition["from"],
    to: Transition["to"],
  ): Transition => ({
    node: "achilles",
    from,
    to,
    reason: undefined,
    acknowledged: false,
  });

  it("lets every change through at warn", () => {
    expect(isWorthNotifying(change("ok", "warn"), "warn")).toBe(true);
    expect(isWorthNotifying(change("absent", "ok"), "warn")).toBe(true);
  });

  it.each<[Transition["from"], Transition["to"], boolean]>([
    ["ok", "critical", true],
    ["critical", "warn", true],
    ["critical", "ok", true],
    ["ok", "stale", true],
    ["stale", "ok", true],
    ["warn", "stale", true],
    ["ok", "warn", false],
    ["warn", "ok", false],
    ["unknown", "warn", false],
    ["absent", "ok", false],
    ["ok", "absent", false],
  ])("at critical, %s → %s notifies: %s", (from, to, expected) => {
    expect(isWorthNotifying(change(from, to), "critical")).toBe(expected);
  });
});

describe("an acknowledged node", () => {
  /** Taken while the node was in warn. */
  const acknowledged = (state: NodeState, untilOk: boolean): NodeState => ({
    ...state,
    acknowledged: {
      node: state.node,
      since: 1_799_990_000,
      status: "warn",
      untilOk,
    },
  });

  const coveredBetween = (before: NodeState, after: NodeState): boolean[] =>
    transitionsBetween(stateOf(before), stateOf(after)).map(
      (each) => each.acknowledged,
    );

  it("covers any status short of ok when sticky", () => {
    expect(
      coveredBetween(
        acknowledged(node("achilles", "warn"), true),
        acknowledged(node("achilles", "critical"), true),
      ),
    ).toEqual([true]);
    expect(
      coveredBetween(
        acknowledged(node("achilles", "critical"), true),
        acknowledged(node("achilles", "ok"), true),
      ),
    ).toEqual([false]);
  });

  // The daemon clears only after a write: gone stale with none, or a change
  // written before every probe ran again after a wake, it is still listed.
  it("covers only its own status when of the default kind", () => {
    expect(
      coveredBetween(
        acknowledged(node("achilles", "warn"), false),
        acknowledged(node("achilles", "stale"), false),
      ),
    ).toEqual([false]);
    expect(
      coveredBetween(
        acknowledged(node("achilles", "stale"), false),
        acknowledged(node("achilles", "warn"), false),
      ),
    ).toEqual([true]);
  });

  it("covers nothing once the daemon has dropped it, or the node is gone", () => {
    expect(
      coveredBetween(
        acknowledged(node("achilles", "warn"), false),
        node("achilles", "critical"),
      ),
    ).toEqual([false]);
    expect(
      transitionsBetween(
        stateOf(acknowledged(node("achilles", "warn"), true)),
        stateOf(),
      ).map((each) => each.acknowledged),
    ).toEqual([false]);
  });

  it.each<["warn" | "critical", Transition["from"], Transition["to"]]>([
    ["warn", "warn", "critical"],
    ["critical", "warn", "critical"],
    ["critical", "warn", "stale"],
    ["warn", "critical", "unknown"],
  ])("at %s, a covered %s → %s does not notify", (level, from, to) => {
    expect(
      isWorthNotifying(
        { node: "achilles", from, to, reason: undefined, acknowledged: true },
        level,
      ),
    ).toBe(false);
  });
});
