import { DISABLED_REASON_TEXT, type ProbeNotRun } from "@ephorate/core";

// Past this many, a count: 198 names on one line help nobody. Chosen.
const NODE_NAMES_SHOWN = 5;

/**
 * `not run: speed on german, hector (off in the config); system on german
 * (no `ssh:` in the config)`. Nothing when everything asked for ran.
 */
export function notRunText(
  notRun: unknown,
  checkedNodeCount: number,
): string | undefined {
  // Read off the wire: a broken entry must not fail a check already drawn.
  const probesNotRun = Array.isArray(notRun)
    ? notRun.filter(isProbeNotRun)
    : [];
  if (probesNotRun.length === 0) return undefined;

  const groupTexts = groupByProbeAndReason(probesNotRun).map(
    ({ probeName, disabledReason, nodeNames }) =>
      `${probeName} on ${describeNodes(nodeNames, checkedNodeCount)} ` +
      `(${describeReason(disabledReason)})`,
  );

  return `not run: ${groupTexts.join("; ")}`;
}

interface NotRunGroup {
  probeName: string;
  disabledReason: string;
  nodeNames: string[];
}

/** One per probe and reason, in the order they first appear. */
function groupByProbeAndReason(
  probesNotRun: readonly ProbeNotRun[],
): NotRunGroup[] {
  const groups = new Map<string, NotRunGroup>();

  for (const { node, probe, disabledReason } of probesNotRun) {
    const key = `${probe}\u0000${disabledReason}`;
    const group = groups.get(key) ?? {
      probeName: probe,
      disabledReason,
      nodeNames: [],
    };
    group.nodeNames.push(node);
    groups.set(key, group);
  }

  return [...groups.values()];
}

function describeNodes(
  nodeNames: readonly string[],
  checkedNodeCount: number,
): string {
  if (checkedNodeCount > 1 && nodeNames.length === checkedNodeCount) {
    return "every node";
  }
  if (nodeNames.length > NODE_NAMES_SHOWN) {
    return `${nodeNames.length} of ${checkedNodeCount} nodes`;
  }

  return nodeNames.join(", ");
}

// A newer serve may know a reason this client does not: its own word then.
function describeReason(disabledReason: string): string {
  return Object.hasOwn(DISABLED_REASON_TEXT, disabledReason)
    ? DISABLED_REASON_TEXT[disabledReason as ProbeNotRun["disabledReason"]]
    : disabledReason;
}

function isProbeNotRun(value: unknown): value is ProbeNotRun {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.node === "string" &&
    typeof candidate.probe === "string" &&
    typeof candidate.disabledReason === "string"
  );
}
