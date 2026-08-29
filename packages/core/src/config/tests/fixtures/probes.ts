import { z } from "zod";
import type { ProbeDescriptor } from "../../../types/probe-contract.js";

/**
 * Stand-ins for the real probes. Every default is a distinct number so a
 * test that reads the wrong layer produces a visibly wrong value rather
 * than accidentally the right one.
 */
export const TEST_PROBES: ProbeDescriptor[] = [
  {
    name: "system",
    requiresExecutor: true,
    enabledByDefault: true,
    defaults: { interval: 61, timeout: 11, retries: 2, concurrency: 51 },
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
  },
  {
    name: "speed",
    requiresExecutor: true,
    // Costly probes ship off.
    enabledByDefault: false,
    defaults: { interval: 3601, timeout: 121, retries: 0, concurrency: 3 },
  },
];
