import { formatDuration } from "../config/duration.js";
import type { ResolvedNode, ResolvedProbe } from "../config/resolve.js";
import type { Threshold } from "../config/schema.js";
import type { Verdict } from "../reachability/verdict.js";
import type { MetricPoint } from "../types/metrics.js";

/**
 * How a single value reads right now.
 *
 * `unknown` and `stale` are kept apart on purpose: a node added a minute ago
 * has no daily `speed` value yet and nothing is wrong, while a `speed` value
 * that stopped arriving is a problem. Collapsing them would make every new
 * node look broken for a day.
 */
export type MetricStatus = "ok" | "warn" | "critical" | "stale" | "unknown";

export type ThresholdLevel = "warn" | "critical";

export interface MetricView {
  metric: string;
  /** The probe that emits it — the part of the id before the first dot. */
  probe: string;
  status: MetricStatus;
  value?: number | undefined;
  ok?: boolean | undefined;
  meta?: Record<string, unknown> | undefined;
  /** Absent when the metric has never arrived. */
  ts?: number | undefined;
  ageSeconds?: number | undefined;
  /** This probe's interval, so a client can say "expected every 30s". */
  expectedEverySeconds: number;
  breached?: ThresholdLevel | undefined;
}

export interface NodeState {
  node: string;
  status: MetricStatus;
  /** `null` when the reachability probe is switched off for this node. */
  reachability: Verdict | null;
  metrics: MetricView[];
  /** Why the node is not `ok`, in words a person can act on. */
  reasons: string[];
}

export interface NodeStateInput {
  /** Already filtered to the nodes the user wants watched. */
  nodes: readonly ResolvedNode[];
  /** What `Storage.latest()` returned. */
  points: readonly MetricPoint[];
  /** Unix seconds. Passed in so staleness is testable without waiting. */
  now: number;
}

/**
 * The one metric id this module knows by name. Reachability is core's own
 * concept — `Verdict` and `summarize()` live in this package — so reading its
 * verdict is not the same thing as core learning about an arbitrary probe.
 */
export const REACHABILITY_VERDICT_METRIC = "reachability.verdict";

const REACHABILITY_PROBE = "reachability";

/**
 * Written by the collector for every probe alike, success or failure, so that
 * "the probe failed" and "the probe never ran" stay distinguishable. Reading
 * it is a collector-wide convention rather than knowledge of any one probe.
 */
const PROBE_LIVENESS_SUFFIX = ".up";

/** What each verdict means for "does this node need me now". */
const VERDICT_SEVERITY: Readonly<Record<Verdict, MetricStatus>> = {
  ok: "ok",
  partial: "warn",
  // Both mean the same thing to a user — nobody can connect. Which of the two
  // it is stays visible in the verdict itself, where it belongs.
  blocked: "critical",
  down: "critical",
  unknown: "unknown",
};

const VERDICT_REASON: Readonly<Record<Verdict, string | undefined>> = {
  ok: undefined,
  partial: "reachable from only part of the required regions",
  blocked:
    "not reachable from the required regions while the control group answers",
  down: "not reachable from any region, the control group included",
  unknown: "not enough regions answered to decide",
};

/**
 * Worst wins. `stale` outranks `warn` because a node we cannot see could be
 * in trouble right now, and blindness is worse than a disk at 86% we know
 * about; it stays below `critical` because a known emergency outranks an
 * unknown one.
 */
const STATUS_RANK: Readonly<Record<MetricStatus, number>> = {
  ok: 0,
  unknown: 1,
  warn: 2,
  stale: 3,
  critical: 4,
};

/**
 * Turns the latest metric rows into one summary per node.
 *
 * Deliberately free of I/O and of any knowledge of concrete probes: every
 * rule below is mechanical, so a probe added later needs no change here.
 */
export function buildNodeState(input: NodeStateInput): NodeState[] {
  const byNode = new Map<string, MetricPoint[]>();

  for (const point of input.points) {
    const bucket = byNode.get(point.node);
    if (bucket) bucket.push(point);
    else byNode.set(point.node, [point]);
  }

  return input.nodes.map((node) =>
    stateFor(node, byNode.get(node.node.name) ?? [], input.now),
  );
}

function stateFor(
  node: ResolvedNode,
  points: readonly MetricPoint[],
  now: number,
): NodeState {
  const enabledProbes = new Map(
    [...node.probes].filter(([, probe]) => probe.enabled),
  );

  const metrics: MetricView[] = [];
  const reasons: string[] = [];
  let status: MetricStatus = "ok";

  const worsenTo = (candidate: MetricStatus): void => {
    if (STATUS_RANK[candidate] > STATUS_RANK[status]) status = candidate;
  };

  // A probe switched off for this node has no axis at all: its points are
  // leftovers from before it was switched off, and showing them would warn
  // about something the user turned off on purpose.
  const relevant = points.filter((point) =>
    enabledProbes.has(probeOf(point.metric)),
  );

  for (const [name, probe] of enabledProbes) {
    const forProbe = relevant.filter((point) => probeOf(point.metric) === name);

    if (forProbe.length === 0) {
      worsenTo("unknown");
      reasons.push(`${name} has not reported yet`);
      continue;
    }

    const staleAges: number[] = [];
    const lastData = lastDataAt(forProbe);

    for (const point of forProbe) {
      // Retired, not stale: the probe has been writing other metrics all
      // along and stopped writing this one. Narrowing
      // `probes.reachability.methods` from `[ping, tcp]` to `[tcp]` leaves
      // the ping rows behind — `metrics_latest` is never pruned on purpose —
      // and judging them against the wall clock alone held a healthy node at
      // `stale` for as long as the database lived.
      if (isRetired(point, lastData, probe.interval)) continue;

      const view = viewOf(point, probe, node.thresholds, now);
      metrics.push(view);
      worsenTo(view.status);

      if (view.status === "stale" && view.ageSeconds !== undefined) {
        staleAges.push(view.ageSeconds);
      }

      const reason = reasonFor(view, node.thresholds.get(point.metric));
      if (reason !== undefined) reasons.push(reason);
    }

    // One line per probe rather than one per value: six stale numbers from
    // one silent probe are one problem, not six.
    if (staleAges.length > 0) {
      const oldest = Math.max(...staleAges);
      reasons.push(
        `${name} last reported ${formatDuration(oldest)} ago, ` +
          `expected every ${formatDuration(probe.interval)}`,
      );
    }
  }

  // `null` and `"unknown"` are different answers: the first is "we do not
  // measure this node's reachability", the second is "we do and cannot tell".
  const measured = enabledProbes.has(REACHABILITY_PROBE);
  const verdictView = metrics.find(
    (view) => view.metric === REACHABILITY_VERDICT_METRIC,
  );
  const verdict = verdictOf(verdictView);
  const reachability = measured ? verdict : null;

  // A verdict is folded in only while it is current. A four-day-old
  // `blocked` describes what was true four days ago, and letting it drive
  // today's status would be the same lie as a green disk from stale numbers;
  // the value is still reported, with its age, for the client to show.
  if (measured && verdictView !== undefined && verdictView.status !== "stale") {
    const severity = VERDICT_SEVERITY[verdict];

    // The verdict metric carries the verdict's own severity rather than the
    // plain `warn` any other false would get: `down` is not a nuance.
    verdictView.status = severity;
    worsenTo(severity);

    const reason = VERDICT_REASON[verdict];
    if (reason !== undefined) reasons.push(reason);
  }

  return { node: node.node.name, status, reachability, metrics, reasons };
}

/**
 * When this probe last produced a measurement, as opposed to when it last
 * ran.
 *
 * `<probe>.up` is excluded deliberately: the collector writes it on failure
 * too, so counting it would say a probe with broken ssh is "producing data"
 * and retire the very values that should be shown, aged, while it is broken.
 * `-Infinity` when the probe has written nothing but `.up`, which retires
 * nothing.
 */
function lastDataAt(points: readonly MetricPoint[]): number {
  const timestamps = points
    .filter((point) => !point.metric.endsWith(PROBE_LIVENESS_SUFFIX))
    .map((point) => point.ts);

  return timestamps.length > 0
    ? Math.max(...timestamps)
    : Number.NEGATIVE_INFINITY;
}

/**
 * How far behind the probe's own last measurement a metric may fall before it
 * is treated as gone rather than late.
 *
 * Deliberately much larger than the two intervals staleness uses, and the
 * gap between the two numbers is the point: below it the metric reads stale,
 * which is the signal that part of a measurement started failing; above it we
 * conclude the probe is no longer writing it at all. Sharing one threshold
 * would leave no window for the warning, and a method that quietly stopped
 * answering would vanish from the table instead of saying so.
 *
 * Ten is a judgement, not a measurement — nothing in the data separates
 * "missing for now" from "removed", only how long it has been missing. It is
 * short enough that a narrowed config clears within an hour at a five-minute
 * interval, long enough that a run of consecutive failures is still reported.
 * The guess disappears once probes declare the metrics they emit; see the
 * debt list.
 */
const RETIREMENT_INTERVALS = 10;

function isRetired(
  point: MetricPoint,
  lastData: number,
  intervalSeconds: number,
): boolean {
  if (point.metric.endsWith(PROBE_LIVENESS_SUFFIX)) return false;

  return lastData - point.ts > intervalSeconds * RETIREMENT_INTERVALS;
}

function viewOf(
  point: MetricPoint,
  probe: ResolvedProbe,
  thresholds: ReadonlyMap<string, Threshold>,
  now: number,
): MetricView {
  // A node whose clock runs ahead produces a point from the future. Negative
  // age is not "very fresh" in any useful sense, and clamping keeps it from
  // being printed as a nonsense duration.
  const ageSeconds = Math.max(0, now - point.ts);
  const stale = ageSeconds > probe.interval * 2;

  const view: MetricView = {
    metric: point.metric,
    probe: probe.name,
    status: "ok",
    ts: point.ts,
    ageSeconds,
    expectedEverySeconds: probe.interval,
  };

  if (point.value !== undefined) view.value = point.value;
  if (point.ok !== undefined) view.ok = point.ok;
  if (point.meta !== undefined) view.meta = point.meta;

  if (stale) {
    // A value too old to trust is not compared against anything: reporting a
    // seven-hour-old 12% as "ok" is the green-from-stale-numbers lie.
    view.status = "stale";
    return view;
  }

  const threshold = thresholds.get(point.metric);

  if (point.value !== undefined && threshold !== undefined) {
    const breached = breachOf(point.value, threshold);
    if (breached !== undefined) {
      view.breached = breached;
      view.status = breached;
      return view;
    }
  }

  // Everything else a `false` can mean is one probe's business, and probes do
  // not describe their metrics yet, so all of them warn rather than some
  // warning and some being an emergency.
  if (point.ok === false && !isDecidedByVerdict(point.metric, probe.name)) {
    view.status = "warn";
  }

  return view;
}

/**
 * Whether `stateFor` settles this metric through the verdict instead.
 *
 * A per-region, per-method reading is an input the probe has already weighed:
 * `summarize()` applied the quorum and told the required regions from the
 * control group, and its answer is the verdict. Letting each failing reading
 * warn separately both double-counts the same fact and buries it — a node
 * unreachable everywhere produced one useful line and five saying "reports a
 * problem", which is how a reasons list stops being read. The verdict itself
 * is here for the same reason: it gets the verdict's own severity, because
 * `down` is not the same nuance as any other `false`.
 *
 * `reachability.up` is emphatically not one of those. The collector writes it
 * for every probe alike to record that the probe ran at all, and check-host
 * refusing requests — it documents no rate limit, so this is the expected way
 * it breaks — has to mark the node rather than pass unnoticed because of a
 * rule about region readings.
 */
function isDecidedByVerdict(metric: string, probe: string): boolean {
  return (
    probe === REACHABILITY_PROBE && !metric.endsWith(PROBE_LIVENESS_SUFFIX)
  );
}

/** Strictly past the bound: `warn: 85` leaves exactly 85 alone. */
function breachOf(
  value: number,
  threshold: Threshold,
): ThresholdLevel | undefined {
  const past = (bound: number): boolean =>
    threshold.worseWhen === "above" ? value > bound : value < bound;

  if (threshold.critical !== undefined && past(threshold.critical)) {
    return "critical";
  }

  if (threshold.warn !== undefined && past(threshold.warn)) return "warn";

  return undefined;
}

function reasonFor(
  view: MetricView,
  threshold: Threshold | undefined,
): string | undefined {
  if (view.breached !== undefined && threshold !== undefined) {
    const bound =
      view.breached === "critical" ? threshold.critical : threshold.warn;
    const side = threshold.worseWhen === "above" ? "above" : "below";

    return `${view.metric} is ${view.value}, ${side} the ${view.breached} threshold of ${bound}`;
  }

  if (view.metric.endsWith(PROBE_LIVENESS_SUFFIX) && view.ok === false) {
    const kind = view.meta?.["errorKind"];
    const detail = view.meta?.["detail"];
    const cause = typeof kind === "string" ? kind : "unknown error";
    const suffix = typeof detail === "string" ? ` (${detail})` : "";

    return `${view.probe} probe failing: ${cause}${suffix}`;
  }

  if (view.status === "warn" && view.ok === false) {
    return `${view.metric} reports a problem`;
  }

  return undefined;
}

function verdictOf(view: MetricView | undefined): Verdict {
  const verdict = view?.meta?.["verdict"];

  return isVerdict(verdict) ? verdict : "unknown";
}

function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && Object.hasOwn(VERDICT_SEVERITY, value);
}

function probeOf(metric: string): string {
  const dot = metric.indexOf(".");

  return dot === -1 ? metric : metric.slice(0, dot);
}
