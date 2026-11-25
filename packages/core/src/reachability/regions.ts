import { z } from "zod";

export const REGION_SETTINGS_EXAMPLE =
  "use `regions: { targets: [ru, kz], control: [de, nl] }`";

const countryCode = z
  .string()
  .regex(/^[a-z]{2}$/i, "use a two-letter country code, such as `ru`")
  .toLowerCase();

export const ReachabilityRegionsSchema = z
  .object({
    targets: z
      .array(countryCode, {
        error: `at least one target country: ${REGION_SETTINGS_EXAMPLE}`,
      })
      .min(1, `at least one target country: ${REGION_SETTINGS_EXAMPLE}`),
    control: z.array(countryCode).default([]),
  })
  .strict()
  .superRefine((regions, context) => {
    const seen = new Set<string>();
    for (const role of ["targets", "control"] as const) {
      regions[role].forEach((country, index) => {
        if (seen.has(country)) {
          context.addIssue({
            code: "custom",
            path: [role, index],
            message: `country "${country}" must appear only once across targets and control`,
          });
        }
        seen.add(country);
      });
    }
  });

export type ReachabilityRegions = z.infer<typeof ReachabilityRegionsSchema>;

export function regionCountries(
  regions: ReachabilityRegions | undefined,
): string[] {
  return regions === undefined ? [] : [...regions.targets, ...regions.control];
}

/** A verdict belongs to the target and control coverage it was measured against. */
export function reachabilityRegionScope(
  settings: Readonly<Record<string, unknown>>,
): string {
  const regions = settings.regions as Partial<ReachabilityRegions> | undefined;
  return JSON.stringify([
    [...(regions?.targets ?? [])].sort(),
    [...(regions?.control ?? [])].sort(),
  ]);
}
