import { z } from "zod";

/**
 * Bounds on `GET /api/metrics`, and the reason the endpoint has them.
 *
 * `Storage.query({})` returns everything, and everything is large: measured,
 * 200k rows come back as 200k objects in 212 ms, 118 MB of heap and 14 MB of
 * JSON, and a real three-node database holds ~3M rows after 90 days. An
 * unbounded request would let anyone who can reach the API exhaust the
 * collector's memory. The storage stays honest — it returns what it is asked
 * for — and the boundary does the protecting.
 */
export const METRICS_QUERY_DEFAULT_LIMIT = 1000;
export const METRICS_QUERY_MAX_LIMIT = 10_000;
/** Used when the caller gives no time range: the last hour. */
export const METRICS_QUERY_DEFAULT_WINDOW_SECONDS = 3600;

/**
 * A whole number as it arrives in a query string.
 *
 * Not `z.coerce.number()`: that runs `Number("")`, which is `0`, so a blank
 * `from=` would be accepted as "since the epoch" — the node's entire history
 * instead of the last hour, with no error. Digits only also refuses `1e3`,
 * `1.5` and `-1` with one message rather than three.
 */
const WholeNumber = z
  .string()
  .regex(/^\d+$/, "expected a whole number")
  .transform(Number);

/**
 * Strict for the same reason the config is: `nod=achilles` returning every
 * node's history is the silent wrong answer, and a 400 naming the key is the
 * loud right one.
 */
export const MetricsQuerySchema = z
  .object({
    node: z.string().min(1).optional(),
    metric: z.string().min(1).optional(),
    /** Unix seconds, inclusive. */
    from: WholeNumber.optional(),
    /** Unix seconds, inclusive. */
    to: WholeNumber.optional(),
    limit: WholeNumber.pipe(
      z.number().min(1).max(METRICS_QUERY_MAX_LIMIT),
    ).optional(),
  })
  .strict()
  .refine(
    (query) =>
      query.from === undefined ||
      query.to === undefined ||
      query.from <= query.to,
    { message: "from must not be later than to", path: ["from"] },
  );

export type MetricsQuery = z.infer<typeof MetricsQuerySchema>;
