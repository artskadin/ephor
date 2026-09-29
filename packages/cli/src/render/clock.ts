// A fixed locale: the user's own gives `7:05:03`, `7.05.03` or wide
// glyphs, and the table measures UTF-16 units.
const CLOCK = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** `19:05:03` for epoch milliseconds, in the local time zone. */
export function clock(ms: number): string {
  return CLOCK.format(new Date(ms));
}
