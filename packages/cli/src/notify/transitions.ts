import type { MetricStatus, StateResponse } from "@ephorate/core";

/** A node's status between two answers; `absent` when it is not listed. */
export interface Transition {
  node: string;
  from: MetricStatus | "absent";
  to: MetricStatus | "absent";
  /** The node's first reason after the change, if it has one. */
  reason: string | undefined;
}

export function transitionsBetween(
  previous: StateResponse,
  next: StateResponse,
): Transition[] {
  const before = new Map(previous.nodes.map((node) => [node.node, node]));
  const after = new Map(next.nodes.map((node) => [node.node, node]));
  const transitions: Transition[] = [];

  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const from = before.get(name)?.status ?? "absent";
    const to = after.get(name)?.status ?? "absent";

    if (from !== to) {
      transitions.push({
        node: name,
        from,
        to,
        reason: after.get(name)?.reasons[0],
      });
    }
  }

  return transitions;
}

/** One line each: `ephor: german` / `stale → critical · not reachable …`. */
export function describeTransition(transition: Transition): {
  title: string;
  body: string;
} {
  const { node, from, to, reason } = transition;
  const change =
    from === "absent"
      ? `new node, ${to}`
      : to === "absent"
        ? "gone from the collector"
        : `${from} → ${to}`;

  return {
    title: `ephor: ${node}`,
    body: reason === undefined ? change : `${change} · ${reason}`,
  };
}

/** From this many changes at once, one notification says how many. */
export const SUMMARY_FROM = 6;

/** `ephor: 12 nodes changed` / `3 critical, 9 ok`, worst first. */
export function summarizeTransitions(transitions: readonly Transition[]): {
  title: string;
  body: string;
} {
  const order = [
    "critical",
    "stale",
    "warn",
    "unknown",
    "ok",
    "absent",
  ] as const;
  const counts = new Map<string, number>();

  for (const { to } of transitions) {
    counts.set(to, (counts.get(to) ?? 0) + 1);
  }

  return {
    title: `ephor: ${transitions.length} nodes changed`,
    body: order
      .filter((status) => counts.has(status))
      .map(
        (status) =>
          `${counts.get(status)} ${status === "absent" ? "gone" : status}`,
      )
      .join(", "),
  };
}
