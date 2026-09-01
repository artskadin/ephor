import { describe, expect, it } from "vitest";
import { Duration, formatDuration } from "../duration.js";

describe("formatDuration", () => {
  it.each([
    [0, "0s"],
    [1, "1s"],
    [59, "59s"],
    [60, "1m"],
    [90, "1m"],
    [3599, "59m"],
    [3600, "1h"],
    [86_399, "23h"],
    [86_400, "1d"],
    [172_800, "2d"],
  ])("turns %i seconds into %s", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  // The age of the data actually sitting in a development database, which is
  // the number a user reads off `ephor status` after a weekend.
  it("keeps the hours next to the days when there are any", () => {
    expect(formatDuration(339_599)).toBe("3d 22h");
  });

  it("says nothing about hours when there are none", () => {
    expect(formatDuration(259_200)).toBe("3d");
  });

  // Read as "at least this old": rounding 3d 22h up to 4d would report time
  // that has not passed.
  it("rounds down rather than to nearest", () => {
    expect(formatDuration(119)).toBe("1m");
    expect(formatDuration(7199)).toBe("1h");
  });

  // A node whose clock runs ahead produces a negative age upstream; printing
  // "-42s" would be worse than saying the value just arrived.
  it("floors a negative duration at zero", () => {
    expect(formatDuration(-42)).toBe("0s");
  });

  it("ignores a fraction of a second", () => {
    expect(formatDuration(59.9)).toBe("59s");
  });

  it("reads back the durations the config accepts", () => {
    for (const written of ["30s", "15m", "2h", "7d"]) {
      expect(formatDuration(Duration.parse(written))).toBe(written);
    }
  });
});
