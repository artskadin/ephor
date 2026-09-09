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
  /** Share of a region's vantage points that must succeed. */
  quorum: z.number().min(0).max(1).default(0.5),
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
