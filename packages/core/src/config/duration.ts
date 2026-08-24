import { z } from "zod";

const DURATION_RE = /^(\d+)(s|m|h|d)?$/;

const FACTOR = { s: 1, m: 60, h: 3600, d: 86400 } as const;

function parseDuration(input: string | number): number {
  if (typeof input === "number") {
    return input;
  }

  const match = DURATION_RE.exec(input.trim());

  if (!match) {
    throw new Error(`Invalid duration: "${input}"`);
  }

  const value = Number(match[1]);
  const unit = (match[2] ?? "s") as keyof typeof FACTOR;

  return value * FACTOR[unit];
}

export const Duration = z
  .union([
    z.number().int().positive(),
    z.string().regex(DURATION_RE, "Expected 30, 30s, 15m, 2h or 7d"),
  ])
  .transform(parseDuration);
