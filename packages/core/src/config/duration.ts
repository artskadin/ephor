import { z } from "zod";

const DURATION_PATTERN = /^(\d+)(s|m|h|d)?$/;

const SECONDS_PER_UNIT = { s: 1, m: 60, h: 3600, d: 86400 } as const;

function parseDuration(input: string | number): number {
  if (typeof input === "number") {
    return input;
  }

  const match = DURATION_PATTERN.exec(input.trim());

  if (!match) {
    throw new Error(`Invalid duration: "${input}"`);
  }

  const value = Number(match[1]);
  const unit = (match[2] ?? "s") as keyof typeof SECONDS_PER_UNIT;

  return value * SECONDS_PER_UNIT[unit];
}

export const Duration = z
  .union([
    z.number().int().positive(),
    z.string().regex(DURATION_PATTERN, "Expected 30, 30s, 15m, 2h or 7d"),
  ])
  .transform(parseDuration);

// `45s`, `7m`, `21h`, `3d 22h`. Rounds down: an age reads as "at least
// this old".
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));

  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m`;
  if (total < 86400) return `${Math.floor(total / 3600)}h`;

  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);

  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}
