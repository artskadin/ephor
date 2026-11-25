import { z } from "zod";
import {
  ReachabilityRegionsSchema,
  regionCountries,
} from "../../../reachability/regions";
import type { ProbeDescriptor } from "../../../types/probe-contract";

/**
 * Stand-ins for the real probes. Every default is a distinct number so a
 * test that reads the wrong layer produces a visibly wrong value rather
 * than accidentally the right one.
 */
const SYSTEM_METRICS = [
  "system.load_percent",
  "system.mem_percent",
  "system.disk_percent",
  "system.ports",
  "system.received_mbps",
  "system.sent_mbps",
];
const PERCENTS = ["system.received_percent", "system.sent_percent"];

// The stand-in has no endpoints, so it lists both methods per country.
const regionMetrics = (settings: Readonly<Record<string, unknown>>) => [
  "reachability.verdict",
  ...regionCountries(
    ReachabilityRegionsSchema.optional().parse(settings.regions),
  ).flatMap((region) =>
    ["tcp", "http"].map((method) => `reachability.${region}.${method}`),
  ),
];

export const TEST_PROBES: ProbeDescriptor[] = [
  {
    name: "system",
    requiresExecutor: true,
    summary: "a test probe",
    defaults: { interval: 61, timeout: 11, retries: 2, concurrency: 51 },
    listMetrics: (node) =>
      node.bandwidth === undefined
        ? SYSTEM_METRICS
        : [...SYSTEM_METRICS, ...PERCENTS],
    listAllMetrics: () => [...SYSTEM_METRICS, ...PERCENTS],
  },
  {
    name: "reachability",
    requiresExecutor: false,
    summary: "a test probe",
    defaults: { interval: 301, timeout: 62, retries: 1, concurrency: 17 },
    settings: {
      quorum: z.number().min(0).max(1).default(0.5),
      regions: ReachabilityRegionsSchema.optional(),
    },
    listMetrics: (_node, settings) => regionMetrics(settings),
    listAllMetrics: regionMetrics,
  },
  {
    name: "speed",
    requiresExecutor: true,
    // With no schedule, as the real one.
    summary: "a test probe",
    defaults: { interval: null, timeout: 121, retries: 0, concurrency: 3 },
    listMetrics: () => ["speed.download_mbps", "speed.upload_mbps"],
    listAllMetrics: () => ["speed.download_mbps", "speed.upload_mbps"],
  },
];

/**
 * `probes:` as `ephor init` writes it, system and reachability on, for a
 * test about something else; sections the test wrote win.
 */
export function withUsualProbes(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const written = (config.probes ?? {}) as Record<string, unknown>;
  return { ...config, probes: { system: {}, reachability: {}, ...written } };
}
