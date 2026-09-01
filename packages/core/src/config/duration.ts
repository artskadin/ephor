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

/**
 * The inverse, for ages and intervals shown to a person: `45s`, `7m`, `21h`,
 * `3d 22h`.
 *
 * Rounds down rather than to nearest, because these are read as "at least
 * this old": a value 3 days and 22 hours behind should not be reported as 4
 * days, which is time that has not passed yet.
 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));

  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m`;
  if (total < 86400) return `${Math.floor(total / 3600)}h`;

  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);

  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}
