import { z } from "zod";

// `Storage.query({})` returns everything: 200k rows measured at 118 MB of
// heap. The limits protect the collector's memory, not the storage.
export const METRICS_QUERY_DEFAULT_LIMIT = 1000;
export const METRICS_QUERY_DEFAULT_WINDOW_SECONDS = 3600;
const METRICS_QUERY_MAX_LIMIT = 10_000;

// Not `z.coerce.number()`: `Number("")` is 0, so a blank `from=` would mean
// "since the epoch".
const WholeNumber = z
  .string()
  .regex(/^\d+$/, "expected a whole number")
  .transform(Number);

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
