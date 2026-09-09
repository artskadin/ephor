import type { ProbeReading, ReachabilityMethod, Vantage } from "./types.js";

/** Methods kept apart: ping ok with tcp failing is filtering, not an outage. */
interface RegionSummary {
  region: string;
  network: Vantage["network"];
  byMethod: Record<ReachabilityMethod, MethodSummary>;
  /** The decisive method met the quorum. */
  ok: boolean;
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
  /** Share of vantage points that must succeed, 0 to 1. */
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

    // TCP decides: ping can pass while the port is filtered.
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

  const allRequiredOk = required.every((region) => region.ok);
  const noRequiredOk = required.every((region) => !region.ok);

  if (allRequiredOk) return "ok";

  if (noRequiredOk) {
    if (control.length > 0 && control.some((region) => region.ok)) {
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
