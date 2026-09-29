import { z } from "zod";
import { Duration } from "../config/duration";

/** A year: past that it is a decision about the node, not a pause. */
const LONGEST_SECONDS = 365 * 86_400;

// The note reaches a table row and a desktop notification: one line, and
// no control characters, or `ESC[2J` in a note would wipe `watch`.
export const AcknowledgeRequestSchema = z
  .object({
    note: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^\P{Cc}*$/u, "note must be one line of plain text")
      .optional(),
    /** Without it, until the node is back to ok. `3d`, `12h` or seconds. */
    duration: Duration.refine(
      (seconds) => seconds > 0 && seconds <= LONGEST_SECONDS,
      "duration must be between 1 second and 365 days",
    ).optional(),
  })
  .strict();

export type AcknowledgeRequest = z.infer<typeof AcknowledgeRequestSchema>;
