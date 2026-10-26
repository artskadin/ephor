import { z } from "zod";
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

// Every method in every configured region: the real probe narrows by its
// `methods`, which this stand-in does not have.
const regionMetrics = (settings: Readonly<Record<string, unknown>>) => [
  "reachability.verdict",
  ...Object.keys(settings.regions ?? {}).flatMap((region) =>
    ["ping", "tcp", "http"].map((method) => `reachability.${region}.${method}`),
  ),
];

export const TEST_PROBES: ProbeDescriptor[] = [
  {
    name: "system",
    requiresExecutor: true,
    enabledByDefault: true,
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
    enabledByDefault: true,
    defaults: { interval: 301, timeout: 62, retries: 1, concurrency: 17 },
    settings: {
      quorum: z.number().min(0).max(1).default(0.5),
      regions: z
        .record(
          z.string(),
          z.object({ match: z.array(z.string().length(2)) }).strict(),
        )
        .default({}),
    },
    listMetrics: (_node, settings) => regionMetrics(settings),
    listAllMetrics: regionMetrics,
  },
  {
    name: "speed",
    requiresExecutor: true,
    // Costly probes ship off, and with no schedule.
    enabledByDefault: false,
    defaults: { interval: null, timeout: 121, retries: 0, concurrency: 3 },
    listMetrics: () => ["speed.download_mbps", "speed.upload_mbps"],
    listAllMetrics: () => ["speed.download_mbps", "speed.upload_mbps"],
  },
];
