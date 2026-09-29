import type { ProbeReading, ReachabilityMethod, Vantage } from "./types";

/** Methods kept apart: ping ok with tcp failing is filtering, not an outage. */
interface RegionSummary {
  region: string;
  network: Vantage["network"];
  byMethod: Partial<Record<ReachabilityMethod, MethodSummary>>;
  /** How many vantage points passed the decisive method. */
  reach: Reach;
  decisive: DecisiveCount;
}

/** A point that did not answer counts as one that failed. */
type Reach = "all" | "some" | "none";

/** Written beside the verdict, so a reason can say how bad: `ru 2/3 tcp`. */
export interface DecisiveCount {
  region: string;
  /** `false` for the control group. */
  required: boolean;
  method: ReachabilityMethod;
  passed: number;
  total: number;
}

interface MethodSummary {
  passed: number;
  total: number;
  /** Median round-trip time of the successful checks, seconds. */
  rtt?: number | undefined;
}

export type Verdict = "ok" | "blocked" | "down" | "partial" | "unknown";

export interface ReachabilityResult {
  regions: RegionSummary[];
  verdict: Verdict;
}

interface VerdictInput {
  readings: readonly ProbeReading[];
  /** The other regions are the control group. */
  requiredRegions: readonly string[];
}

export function summarize(input: VerdictInput): ReachabilityResult {
  const regions = groupIntoRegions(input.readings, input.requiredRegions);

  return {
    regions,
    verdict: decideVerdict(regions, input.requiredRegions),
  };
}

function groupIntoRegions(
  readings: readonly ProbeReading[],
  requiredRegions: readonly string[],
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

    // TCP decides: ping can pass while the port is filtered. Every reading
    // has one of the three methods, so one is always found.
    const method =
      (["tcp", "http", "ping"] as const).find(
        (candidate) => byMethod[candidate] !== undefined,
      ) ?? "ping";
    const counts = byMethod[method] ?? { passed: 0, total: 0 };

    return {
      region,
      network: group[0]?.vantage.network ?? "datacenter",
      byMethod,
      reach: reachOf(counts),
      decisive: {
        region,
        required: requiredRegions.includes(region),
        method,
        passed: counts.passed,
        total: counts.total,
      },
    };
  });
}

// One point that cannot reach the node is a problem to look at: some of
// the users behind that network are cut off.
function reachOf(counts: MethodSummary): Reach {
  if (counts.passed === 0) return "none";

  return counts.passed === counts.total ? "all" : "some";
}

function summarizeMethods(
  readings: readonly ProbeReading[],
): Partial<Record<ReachabilityMethod, MethodSummary>> {
  const result: Partial<Record<ReachabilityMethod, MethodSummary>> = {};

  for (const method of ["ping", "tcp", "http"] as const) {
    const forMethod = readings.filter((reading) => reading.method === method);
    if (forMethod.length === 0) continue;

    const passed = forMethod.filter((reading) => reading.ok);
    const times = passed
      .map((reading) => reading.rtt)
      .filter((time): time is number => time !== undefined);

    result[method] = {
      passed: passed.length,
      total: forMethod.length,
      rtt: median(times),
    };
  }

  return result;
}

// Without a control region "blocked" and "down" look the same.
function decideVerdict(
  regions: readonly RegionSummary[],
  requiredRegions: readonly string[],
): Verdict {
  if (regions.length === 0) return "unknown";

  const required = regions.filter((region) =>
    requiredRegions.includes(region.region),
  );
  const control = regions.filter(
    (region) => !requiredRegions.includes(region.region),
  );

  if (required.length === 0) return "unknown";

  if (required.every((region) => region.reach === "all")) return "ok";

  if (required.every((region) => region.reach === "none")) {
    if (control.some((region) => region.reach !== "none")) {
      return "blocked";
    }
    if (control.length > 0) return "down";
    return "unknown";
  }

  return "partial";
}

/** A median survives one slow vantage point; a mean does not. */
function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle];
}
