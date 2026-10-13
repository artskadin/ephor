import { z } from "zod";

// A promise to the caller, not a server limit: nothing server-side cuts a
// slow answer. 200 nodes of `system` fit under it; a fleet-wide
// `reachability` does not and comes back `complete: false`.
export const CHECK_MAX_WAIT_SECONDS = 240;

const ProbeNamesSchema = z.array(z.string().min(1)).min(1);

const SELECTORS = ["probe", "probes", "skip"] as const;

export const CheckRequestSchema = z
  .object({
    node: z.string().min(1).optional(),
    // One probe, as ephor before `probes` sends it: one name still reaches
    // an older serve.
    probe: z.string().min(1).optional(),
    probes: ProbeNamesSchema.optional(),
    skip: ProbeNamesSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const given = SELECTORS.filter((key) => request[key] !== undefined);
    if (given.length > 1) {
      context.addIssue({
        code: "custom",
        message: `${given.join(" and ")} together: give one of them`,
      });
    }
  });

export type CheckRequest = z.infer<typeof CheckRequestSchema>;

/** Of `available`, in its order, those the request asks for. */
export function probesAsked(
  request: CheckRequest,
  available: readonly string[],
): string[] {
  const { probe, probes, skip } = request;

  if (probe !== undefined) return available.filter((name) => name === probe);
  if (probes !== undefined) {
    return available.filter((name) => probes.includes(name));
  }
  if (skip !== undefined) {
    return available.filter((name) => !skip.includes(name));
  }

  return [...available];
}

/** `every probe`, `system, speed`, `every probe but speed`. */
export function describeProbesAsked(request: CheckRequest): string {
  const { probe, probes, skip } = request;

  if (probe !== undefined) return probe;
  if (probes !== undefined) return probes.join(", ");
  if (skip !== undefined) return `every probe but ${skip.join(", ")}`;

  return "every probe";
}

/** Every name the request gives, to check against the registry. */
export function probesNamed(request: CheckRequest): string[] {
  const { probe, probes = [], skip = [] } = request;

  return [...(probe === undefined ? [] : [probe]), ...probes, ...skip];
}
