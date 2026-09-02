import { z } from "zod";

/**
 * The longest `POST /api/check` will block, whatever the config says.
 *
 * Nothing on the server side cuts a slow answer — Node's `requestTimeout`
 * bounds receiving the request, not answering it, and Fastify sets it to 0
 * regardless — so this is a promise to the caller rather than a limit worked
 * around: a script gets its one answer within four minutes, and a client
 * whose own timeout is above this number never gives up on a run that is
 * still going to answer. 200 nodes of `system` at the default concurrency
 * fit under it in four waves; a fleet-wide `reachability` does not, and
 * comes back `complete: false` with `pending` saying what is left.
 */
export const CHECK_MAX_WAIT_SECONDS = 240;

/**
 * Both optional, so one route serves `ephor check`, `check achilles` and
 * `check achilles system`. Strict for the reason the config is: `nod: x`
 * checking the whole fleet is a silent wrong answer.
 */
export const CheckRequestSchema = z
  .object({
    node: z.string().min(1).optional(),
    probe: z.string().min(1).optional(),
  })
  .strict();

export type CheckRequest = z.infer<typeof CheckRequestSchema>;
