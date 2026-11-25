import { Duration, ReachabilityRegionsSchema } from "@ephorate/core";
import { z } from "zod";

// There is no default audience. The enabled probe requires targets.
export const reachabilitySettingsShape = {
  provider: z.enum(["check-host.net"]).default("check-host.net"),
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
  regions: ReachabilityRegionsSchema.optional(),
} satisfies z.ZodRawShape;

export const ReachabilitySettingsSchema = z
  .object(reachabilitySettingsShape)
  .strict();

export type ReachabilitySettings = z.infer<typeof ReachabilitySettingsSchema>;
