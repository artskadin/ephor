import { Duration } from "@ephorate/core";
import { z } from "zod";

// `required: false` regions are the control group: without one, "blocked
// in Russia" and "the server is gone" look identical.
const RegionSchema = z
  .object({
    /** ISO country codes a vantage point may belong to. */
    match: z.array(z.string().length(2)).min(1),
    count: z.number().int().min(1).default(3),
    required: z.boolean().default(false),
  })
  .strict();

export type Region = z.infer<typeof RegionSchema>;

// `regions` has no default: any default is an opinion about where the
// user's audience lives. Empty makes the probe report "not configured".
export const reachabilitySettingsShape = {
  provider: z.enum(["check-host.net"]).default("check-host.net"),
  methods: z
    .array(z.enum(["ping", "tcp", "http"]))
    .min(1)
    .default(["ping", "tcp"]),
  // Removed 2026-09-29: a node is ok only when every vantage point reaches
  // it. Said out loud, since `.strict()` would only call the key unknown.
  quorum: z
    .never({
      error:
        "quorum was removed: a region is ok only when every vantage point " +
        "reaches the node, and some but not all reads as partial. Delete " +
        "the line.",
    })
    .optional(),
  vantageRefresh: Duration.default(86_400),
  regions: z.record(z.string(), RegionSchema).default({}),
} satisfies z.ZodRawShape;

export const ReachabilitySettingsSchema = z
  .object(reachabilitySettingsShape)
  .strict();

export type ReachabilitySettings = z.infer<typeof ReachabilitySettingsSchema>;

export function requiredRegionsOf(
  settings: ReachabilitySettings,
): readonly string[] {
  return Object.entries(settings.regions)
    .filter(([, region]) => region.required)
    .map(([key]) => key);
}
