import { Duration } from "@ephor/core";
import { z } from "zod";

/**
 * A named group of vantage points.
 *
 * `required: false` regions are not extra data — they are the control group.
 * Without one, "blocked in Russia" and "the server is gone" look identical.
 */
export const RegionSchema = z
  .object({
    /** ISO country codes a vantage point may belong to. */
    match: z.array(z.string().length(2)).min(1),
    /** How many vantage points to use from this region. */
    count: z.number().int().min(1).default(3),
    required: z.boolean().default(false),
  })
  .strict();

export type Region = z.infer<typeof RegionSchema>;

/**
 * Settings the reachability probe adds to its `probes.reachability` section.
 *
 * `regions` has no default on purpose: any default would be an opinion about
 * where the user's audience lives. An empty map makes the probe report
 * "not configured" rather than silently measuring nothing.
 */
export const reachabilitySettingsShape = {
  provider: z.enum(["check-host.net"]).default("check-host.net"),
  methods: z
    .array(z.enum(["ping", "tcp", "http"]))
    .min(1)
    .default(["ping", "tcp"]),
  /** Share of a region's vantage points that must succeed. */
  quorum: z.number().min(0).max(1).default(0.5),
  /** How long the list of vantage points stays usable before refetching. */
  vantageRefresh: Duration.default(86_400),
  regions: z.record(z.string(), RegionSchema).default({}),
} satisfies z.ZodRawShape;

export const ReachabilitySettingsSchema = z
  .object(reachabilitySettingsShape)
  .strict();

export type ReachabilitySettings = z.infer<typeof ReachabilitySettingsSchema>;

/** Region keys that must pass; the rest act as the control group. */
export function requiredRegionsOf(
  settings: ReachabilitySettings,
): readonly string[] {
  return Object.entries(settings.regions)
    .filter(([, region]) => region.required)
    .map(([key]) => key);
}
