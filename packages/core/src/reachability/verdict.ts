import type { ProbeReading, ReachabilityMethod, Vantage } from "./types.js";

/**
 * Aggregated result for one region.
 * Methods are kept apart because their combination is the diagnosis:
 * ping ok + tcp failing means filtering, not an outage.
 */
export interface RegionSummary {
  region: string;
  network: Vantage["network"];
  byMethod: Record<ReachabilityMethod, MethodSummary>;
  /** Region passes when the required methods meet quorum. */
  ok: boolean;
}

export interface MethodSummary {
  passed: number;
  total: number;
  /** Median round-trip time of successful checks, in seconds. */
  rtt?: number | undefined;
}

export type Verdict =
  /** Everything reachable where it should be. */
  | "ok"
  /** Required region fails while a control region passes. */
  | "blocked"
  /** Nothing answers anywhere. */
  | "down"
  /** Some vantage points in a required region fail. */
  | "partial"
  /** Not enough data to decide. */
  | "unknown";

export interface ReachabilityResult {
  regions: RegionSummary[];
  verdict: Verdict;
}

export interface VerdictInput {
  readings: readonly ProbeReading[];
  /** Region keys that must pass; others act as a control group. */
  requiredRegions: readonly string[];
  /** Share of vantage points that must succeed. */
  quorum: number;
}

export function summarize(input: VerdictInput): ReachabilityResult {
  const regions = groupIntoRegions(input.readings, input.quorum);

  return {
    regions,
    verdict: decideVerdict(regions, input.requiredRegions),
  };
}

function groupIntoRegions(
  readings: readonly ProbeReading[],
  quorum: number,
): RegionSummary[] {
  const buckets = new Map<string, ProbeReading[]>();

  for (const reading of readings) {
    const key = reading.vantage.region;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(reading);
    else buckets.set(key, [reading]);
  }

  return [...buckets].map(([region, group]) => {
    const byMethod = summarizeMethods(group);

    // TCP decides reachability: ping can succeed while the port is
    // filtered, which is exactly the case we care about.
    const decisive = byMethod.tcp ?? byMethod.http ?? byMethod.ping;
    const ok =
      decisive !== undefined &&
      decisive.total > 0 &&
      decisive.passed / decisive.total >= quorum;

    return {
      region,
      network: group[0]?.vantage.network ?? "datacenter",
      byMethod,
      ok,
    };
  });
}

function summarizeMethods(
  readings: readonly ProbeReading[],
): Record<ReachabilityMethod, MethodSummary> {
  const result = {} as Record<ReachabilityMethod, MethodSummary>;

  for (const method of ["ping", "tcp", "http"] as const) {
    const forMethod = readings.filter((r) => r.method === method);
    if (forMethod.length === 0) continue;

    const passed = forMethod.filter((r) => r.ok);
    const times = passed
      .map((r) => r.rtt)
      .filter((t): t is number => t !== undefined);

    result[method] = {
      passed: passed.length,
      total: forMethod.length,
      rtt: median(times),
    };
  }

  return result;
}

/**
 * The verdict comes from comparing regions, not from any single one.
 * Without a control region, "blocked in Russia" and "server is down"
 * look identical.
 */
function decideVerdict(
  regions: readonly RegionSummary[],
  requiredRegions: readonly string[],
): Verdict {
  if (regions.length === 0) return "unknown";

  const required = regions.filter((r) => requiredRegions.includes(r.region));
  const control = regions.filter((r) => !requiredRegions.includes(r.region));

  if (required.length === 0) return "unknown";

  const allRequiredOk = required.every((r) => r.ok);
  const noRequiredOk = required.every((r) => !r.ok);

  if (allRequiredOk) return "ok";

  if (noRequiredOk) {
    // Control group tells blocking apart from an outage.
    if (control.length > 0 && control.some((r) => r.ok)) return "blocked";
    if (control.length > 0) return "down";
    return "unknown";
  }

  return "partial";
}

/** Median resists a single slow vantage point better than a mean. */
function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle];
}
