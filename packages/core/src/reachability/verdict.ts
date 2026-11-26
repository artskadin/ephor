import type { ReachabilityRegions } from "./regions";
import type { ProbeReading, ReachabilityMethod, Vantage } from "./types";

interface CountrySummary {
  decisive: DecisiveCount;
  reportingPoints: string[];
  network: Vantage["network"] | undefined;
  rtt: number | undefined;
}

/** Written beside the verdict, so a reason can say how bad: `ru 2/3 tcp`. */
export interface DecisiveCount {
  region: string;
  /** `false` for the control group. */
  required: boolean;
  method: ReachabilityMethod;
  passed: number;
  total: number;
  /** Omitted when every selected point reported. */
  reported?: number;
}

export type Verdict = "ok" | "blocked" | "down" | "partial" | "unknown";

export interface ReachabilityResult {
  regions: CountrySummary[];
  verdict: Verdict;
}

interface VerdictInput {
  readings: readonly ProbeReading[];
  regions: ReachabilityRegions;
  method: ReachabilityMethod;
}

export function summarize({
  readings,
  regions,
  method,
}: VerdictInput): ReachabilityResult {
  const buckets = new Map<string, ProbeReading[]>();

  for (const reading of readings) {
    if (reading.method !== method) continue;
    const key = reading.vantage.countryCode;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(reading);
    else buckets.set(key, [reading]);
  }

  const targets = regions.targets.map((country) =>
    summarizeCountry(country, true, method, buckets.get(country) ?? []),
  );
  const control = regions.control.map((country) =>
    summarizeCountry(country, false, method, buckets.get(country) ?? []),
  );
  return {
    regions: [...targets, ...control],
    verdict: decideVerdict(
      targets.map(({ decisive }) => decisive),
      control.map(({ decisive }) => decisive),
    ),
  };
}

function summarizeCountry(
  country: string,
  required: boolean,
  method: ReachabilityMethod,
  readings: readonly ProbeReading[],
): CountrySummary {
  const reported = readings.filter((reading) => reading.observed !== false);
  const passed = reported.filter((reading) => reading.ok);
  const times = passed.flatMap(({ rtt }) => (rtt === undefined ? [] : [rtt]));
  return {
    network: readings[0]?.vantage.network,
    rtt: median(times),
    reportingPoints: reported.map(({ vantage }) => vantage.id).sort(),
    decisive: {
      region: country,
      required,
      method,
      passed: passed.length,
      total: readings.length,
      ...(reported.length === readings.length
        ? {}
        : { reported: reported.length }),
    },
  };
}

function everyPointFailed(country: DecisiveCount): boolean {
  return (
    country.total > 0 && country.passed === 0 && country.reported === undefined
  );
}

function decideVerdict(
  targets: readonly DecisiveCount[],
  control: readonly DecisiveCount[],
): Verdict {
  if (targets.length === 0) return "unknown";
  if (targets.every(({ passed, total }) => total > 0 && passed === total))
    return "ok";

  if (targets.every(everyPointFailed)) {
    if (control.some(({ passed }) => passed > 0)) return "blocked";
    if (control.length > 0 && control.every(everyPointFailed)) return "down";
    return "unknown";
  }

  const hasSuccess = targets.some(({ passed }) => passed > 0);
  const hasFailure = targets.some(
    ({ reported, total, passed }) => (reported ?? total) > passed,
  );
  return hasSuccess && hasFailure ? "partial" : "unknown";
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
