import type { MetricStatus, NodeState, StateResponse } from "@ephorate/core";
import { describe, expect, it } from "vitest";
import {
  describeTransition,
  SUMMARY_FROM,
  summarizeTransitions,
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
      { node: "german", from: "critical", to: "ok", reason: undefined },
    ]);
  });

  it("treats a node appearing or disappearing as a transition", () => {
    expect(
      transitionsBetween(
        stateOf(node("achilles", "ok")),
        stateOf(node("hector", "ok")),
      ),
    ).toEqual([
      { node: "achilles", from: "ok", to: "absent", reason: undefined },
      { node: "hector", from: "absent", to: "ok", reason: undefined },
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
      }).body,
    ).toBe("new node, ok");
    expect(
      describeTransition({
        node: "hector",
        from: "ok",
        to: "absent",
        reason: undefined,
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
      }),
    );

    expect(summarizeTransitions(transitions)).toEqual({
      title: "ephor: 12 nodes changed",
      body: "3 critical, 7 ok, 2 gone",
    });
  });
});
