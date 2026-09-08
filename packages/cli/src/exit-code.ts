import type { NodeState } from "@ephor/core";

/**
 * Part of the contract: scripts branch on these. 0 when every node is
 * `ok`, 1 when any is not, 2 when the tool itself failed and the nodes
 * were never seen.
 */
export const EXIT_OK = 0;
export const EXIT_NODE_PROBLEMS = 1;
export const EXIT_TOOL_ERROR = 2;

/**
 * `unknown` counts as a problem: a node that has not reported is not known
 * to be fine, and a script polling a fresh daemon must not see green before
 * the first measurements land. `buildNodeState` ranks it above `ok` for the
 * same reason. An empty fleet has nothing wrong with it.
 */
export function exitCodeFor(
  nodes: readonly NodeState[],
): typeof EXIT_OK | typeof EXIT_NODE_PROBLEMS {
  return nodes.every((node) => node.status === "ok")
    ? EXIT_OK
    : EXIT_NODE_PROBLEMS;
}
