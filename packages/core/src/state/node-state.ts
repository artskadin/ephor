import { formatDuration } from "../config/duration";
import type { ResolvedNode, ResolvedProbe } from "../config/resolve";
import type { Threshold } from "../config/schema";
import type { Verdict } from "../reachability/verdict";
import type { MetricPoint } from "../types/metrics";

/** `unknown` (never arrived) and `stale` (stopped arriving) stay apart. */
export type MetricStatus = "ok" | "warn" | "critical" | "stale" | "unknown";

/** What a value says on its own, whatever its age. */
export type MetricSeverity = Exclude<MetricStatus, "stale">;

type ThresholdLevel = "warn" | "critical";

export interface MetricView {
  metric: string;
  /** The part of the id before the first dot. */
  probe: string;
  /** Folds the age in first: a stale value is `stale` here whatever it says. */
  status: MetricStatus;
  /**
   * How the value read when measured: a threshold level, `false → warn`,
   * the verdict's own. Never drives the node's status; a table paints the
   * value by it and the age by `status`.
   */
  severity: MetricSeverity;
  value?: number | undefined;
  ok?: boolean | undefined;
  meta?: Record<string, unknown> | undefined;
  ts?: number | undefined;
  ageSeconds?: number | undefined;
  /** The probe's interval, for "expected every 30s". */
  expectedEverySeconds: number;
  breached?: ThresholdLevel | undefined;
}

export interface NodeState {
  node: string;
  status: MetricStatus;
  /** `null` when the probe is switched off for this node. */
  reachability: Verdict | null;
  /** Enabled probes in registry order; enabled but silent is still listed. */
  probes: string[];
  metrics: MetricView[];
  /** Why the node is not `ok`. */
  reasons: string[];
}

interface NodeStateInput {
  nodes: readonly ResolvedNode[];
  /** What `Storage.latest()` returned. */
  points: readonly MetricPoint[];
  /** Unix seconds, injected so staleness is testable. */
  now: number;
}

/** The one metric named here: reachability is core's own concept. */
export const REACHABILITY_VERDICT_METRIC = "reachability.verdict";

const REACHABILITY_PROBE = "reachability";

/** Written for every probe, success or failure. */
const PROBE_LIVENESS_SUFFIX = ".up";

const VERDICT_SEVERITY: Readonly<Record<Verdict, MetricSeverity>> = {
  ok: "ok",
  partial: "warn",
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

// Worst wins. `stale` outranks `warn`: a node we cannot see may be in
// trouble right now.
const STATUS_RANK: Readonly<Record<MetricStatus, number>> = {
  ok: 0,
  unknown: 1,
  warn: 2,
  stale: 3,
  critical: 4,
};

export function buildNodeState(input: NodeStateInput): NodeState[] {
  const byNode = new Map<string, MetricPoint[]>();

  for (const point of input.points) {
    const bucket = byNode.get(point.node);
    if (bucket) bucket.push(point);
    else byNode.set(point.node, [point]);
  }

  return input.nodes.map((node) =>
    buildNodeStateFor(node, byNode.get(node.node.name) ?? [], input.now),
  );
}

function buildNodeStateFor(
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

  // Points of a probe switched off for this node are leftovers.
  const relevant = points.filter((point) =>
    enabledProbes.has(probeNameOf(point.metric)),
  );

  for (const [name, probe] of enabledProbes) {
    const forProbe = relevant.filter(
      (point) => probeNameOf(point.metric) === name,
    );

    if (forProbe.length === 0) {
      worsenTo("unknown");
      reasons.push(`${name} has not reported yet`);
      continue;
    }

    const staleAges: number[] = [];
    const lastMeasurement = lastMeasurementTs(forProbe);

    for (const point of forProbe) {
      if (isRetired(point, lastMeasurement, probe.interval)) continue;

      const view = buildMetricView(point, probe, node.thresholds, now);
      metrics.push(view);
      worsenTo(view.status);

      if (view.status === "stale" && view.ageSeconds !== undefined) {
        staleAges.push(view.ageSeconds);
      }

      const reason = reasonFor(view, node.thresholds.get(point.metric));
      if (reason !== undefined) reasons.push(reason);
    }

    // One line per silent probe, not one per value.
    if (staleAges.length > 0) {
      const oldest = Math.max(...staleAges);
      reasons.push(
        `${name} last reported ${formatDuration(oldest)} ago, ` +
          `expected every ${formatDuration(probe.interval)}`,
      );
    }
  }

  // `null` is "not measured", `unknown` is "measured and cannot tell".
  const measured = enabledProbes.has(REACHABILITY_PROBE);
  const verdictView = metrics.find(
    (view) => view.metric === REACHABILITY_VERDICT_METRIC,
  );
  const verdict = verdictFromView(verdictView);
  const reachability = measured ? verdict : null;

  if (measured && verdictView !== undefined) {
    const severity = VERDICT_SEVERITY[verdict];
    verdictView.severity = severity;

    // A stale verdict is reported but does not drive today's status.
    if (verdictView.status !== "stale") {
      verdictView.status = severity;
      worsenTo(severity);

      const reason = VERDICT_REASON[verdict];
      if (reason !== undefined) reasons.push(reason);
    }
  }

  return {
    node: node.node.name,
    status,
    reachability,
    probes: [...enabledProbes.keys()],
    metrics,
    reasons,
  };
}

// When the probe last measured, not when it last ran: `.up` is written on
// failure too, and counting it would retire the values a broken probe
// should keep showing.
function lastMeasurementTs(points: readonly MetricPoint[]): number {
  const timestamps = points
    .filter((point) => !point.metric.endsWith(PROBE_LIVENESS_SUFFIX))
    .map((point) => point.ts);

  return timestamps.length > 0
    ? Math.max(...timestamps)
    : Number.NEGATIVE_INFINITY;
}

// A metric this far behind the probe's own last measurement was dropped by
// the probe (a narrowed config; `metrics_latest` is never pruned). Well
// above the 2× staleness window: the gap is where a metric warns as stale
// before it vanishes. Ten is a judgement, gone once probes declare metrics.
const RETIREMENT_INTERVALS = 10;

function isRetired(
  point: MetricPoint,
  lastMeasurement: number,
  intervalSeconds: number,
): boolean {
  if (point.metric.endsWith(PROBE_LIVENESS_SUFFIX)) return false;

  return lastMeasurement - point.ts > intervalSeconds * RETIREMENT_INTERVALS;
}

function buildMetricView(
  point: MetricPoint,
  probe: ResolvedProbe,
  thresholds: ReadonlyMap<string, Threshold>,
  now: number,
): MetricView {
  // A clock running ahead gives a point from the future.
  const ageSeconds = Math.max(0, now - point.ts);
  const stale = ageSeconds > probe.interval * 2;

  const view: MetricView = {
    metric: point.metric,
    probe: probe.name,
    status: "ok",
    severity: "ok",
    ts: point.ts,
    ageSeconds,
    expectedEverySeconds: probe.interval,
  };

  if (point.value !== undefined) view.value = point.value;
  if (point.ok !== undefined) view.ok = point.ok;
  if (point.meta !== undefined) view.meta = point.meta;

  const threshold = thresholds.get(point.metric);
  const breached =
    point.value !== undefined && threshold !== undefined
      ? exceededThresholdLevel(point.value, threshold)
      : undefined;

  if (breached !== undefined) {
    view.severity = breached;
  } else if (
    point.ok === false &&
    !isDecidedByVerdict(point.metric, probe.name)
  ) {
    // Probes do not describe their metrics yet, so every `false` is a warn.
    view.severity = "warn";
  }

  // A value too old to trust decides nothing; what it read stays in
  // `severity`.
  if (stale) {
    view.status = "stale";
    return view;
  }

  view.status = view.severity;
  if (breached !== undefined) view.breached = breached;

  return view;
}

// Region readings and the verdict itself: the verdict already weighed them,
// and each failing reading warning on its own would bury it. `.up` is not
// one of those: check-host refusing requests must mark the node.
function isDecidedByVerdict(metric: string, probe: string): boolean {
  return (
    probe === REACHABILITY_PROBE && !metric.endsWith(PROBE_LIVENESS_SUFFIX)
  );
}

/** Strictly past the bound: `warn: 85` leaves exactly 85 alone. */
function exceededThresholdLevel(
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
    const kind = view.meta?.errorKind;
    const detail = view.meta?.detail;
    const cause = typeof kind === "string" ? kind : "unknown error";
    const suffix = typeof detail === "string" ? ` (${detail})` : "";

    return `${view.probe} probe failing: ${cause}${suffix}`;
  }

  if (view.status === "warn" && view.ok === false) {
    return `${view.metric} reports a problem`;
  }

  return undefined;
}

function verdictFromView(view: MetricView | undefined): Verdict {
  const verdict = view?.meta?.verdict;

  return isVerdict(verdict) ? verdict : "unknown";
}

function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && Object.hasOwn(VERDICT_SEVERITY, value);
}

function probeNameOf(metric: string): string {
  const dot = metric.indexOf(".");

  return dot === -1 ? metric : metric.slice(0, dot);
}
