import { z } from "zod";

// A promise to the caller, not a server limit: nothing server-side cuts a
// slow answer. 200 nodes of `system` fit under it; a fleet-wide
// `reachability` does not and comes back `complete: false`.
export const CHECK_MAX_WAIT_SECONDS = 240;

export const CheckRequestSchema = z
  .object({
    node: z.string().min(1).optional(),
    probe: z.string().min(1).optional(),
  })
  .strict();

export type CheckRequest = z.infer<typeof CheckRequestSchema>;
