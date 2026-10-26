import { DISABLED_REASON_TEXT, type ResolvedNode } from "@ephorate/core";

// Past this many, a count: a fleet of 200 must not print 200 names a line.
const NODE_NAMES_SHOWN = 5;

interface CoverageLine {
  /** Switched on in the config, yet it runs on no node. */
  isWarning: boolean;
  text: string;
}

/**
 * One line a probe, for `serve`'s start, since nothing runs by default:
 * `probe system: on 3 of 4 nodes; not on antilochus (no `ssh:` in the
 * config)`, `probe reachability: on every node (4)`, `probe speed: off`, and
 * `probe system: on achilles` for a fleet of one.
 */
export function describeProbeCoverage(
  nodes: readonly ResolvedNode[],
  probeNames: readonly string[],
): CoverageLine[] {
  // Every node `enabled: false`: the config allows it, and nothing runs.
  if (nodes.length === 0) {
    return [{ isWarning: true, text: "no node is enabled: nothing runs" }];
  }

  return probeNames.map((probeName) => {
    const notRunning = new Map<string, string[]>();
    const runningNames: string[] = [];

    for (const node of nodes) {
      const resolvedProbe = node.probes.get(probeName);
      if (resolvedProbe === undefined) continue;
      if (resolvedProbe.enabled) {
        runningNames.push(node.config.name);
        continue;
      }
      const reasonText = DISABLED_REASON_TEXT[resolvedProbe.disabledReason];
      notRunning.set(reasonText, [
        ...(notRunning.get(reasonText) ?? []),
        node.config.name,
      ]);
    }

    return {
      isWarning: runningNames.length === 0 && !isOffByConfigOnly(notRunning),
      text: `probe ${probeName}: ${describeCoverage(runningNames, nodes.length, notRunning)}`,
    };
  });
}

function isOffByConfigOnly(notRunning: ReadonlyMap<string, string[]>) {
  return [...notRunning.keys()].every(
    (reasonText) => reasonText === DISABLED_REASON_TEXT.config,
  );
}

function describeCoverage(
  runningNames: readonly string[],
  nodeCount: number,
  notRunning: ReadonlyMap<string, string[]>,
): string {
  const runningCount = runningNames.length;
  if (runningCount === nodeCount) {
    return nodeCount === 1
      ? `on ${runningNames[0] ?? ""}`
      : `on every node (${nodeCount})`;
  }
  if (runningCount === 0 && isOffByConfigOnly(notRunning)) return "off";

  const [onlyReason, ...otherReasons] = notRunning.keys();
  if (runningCount === 0 && otherReasons.length === 0) {
    return `on no node (${onlyReason})`;
  }

  const running =
    runningCount === 0
      ? "on no node"
      : `on ${runningCount} of ${nodeCount} nodes`;
  const groups = [...notRunning].map(
    ([reasonText, nodeNames]) =>
      `${describeNodes(nodeNames, nodeCount)} (${reasonText})`,
  );
  return `${running}; not on ${groups.join("; ")}`;
}

function describeNodes(nodeNames: readonly string[], nodeCount: number) {
  if (nodeCount > 1 && nodeNames.length === nodeCount) return "every node";
  if (nodeNames.length > NODE_NAMES_SHOWN) return `${nodeNames.length} nodes`;
  return nodeNames.join(", ");
}
