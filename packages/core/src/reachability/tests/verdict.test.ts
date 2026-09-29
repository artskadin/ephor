import { describe, expect, it } from "vitest";
import type { ProbeReading, ReachabilityMethod, Vantage } from "../types";
import { summarize } from "../verdict";

/** `passed` of `total` points in a region answered the method. */
function readings(
  region: string,
  method: ReachabilityMethod,
  passed: number,
  total: number,
): ProbeReading[] {
  return Array.from({ length: total }, (_, index) => {
    const vantage: Vantage = {
      id: `${region}-${index}`,
      region,
      countryCode: region,
      network: "datacenter",
    };

    return { vantage, method, ok: index < passed };
  });
}

function verdictOf(...groups: ProbeReading[][]) {
  return summarize({ readings: groups.flat(), requiredRegions: ["ru"] })
    .verdict;
}

describe("summarize", () => {
  it.each([
    [3, "ok"],
    [2, "partial"],
    [1, "partial"],
    [0, "blocked"],
  ] as const)("reads %i of 3 RU points, EU all, as %s", (passed, verdict) => {
    expect(
      verdictOf(readings("ru", "tcp", passed, 3), readings("eu", "tcp", 3, 3)),
    ).toBe(verdict);
  });

  it("calls it down when the control group fails too", () => {
    expect(
      verdictOf(readings("ru", "tcp", 0, 3), readings("eu", "tcp", 0, 3)),
    ).toBe("down");
  });

  // One control point answering proves the server is up.
  it("calls it blocked when only part of the control group answers", () => {
    expect(
      verdictOf(readings("ru", "tcp", 0, 3), readings("eu", "tcp", 1, 3)),
    ).toBe("blocked");
  });

  it("cannot tell blocked from down without a control group", () => {
    expect(verdictOf(readings("ru", "tcp", 0, 3))).toBe("unknown");
  });

  // Filtering looks exactly like this: ICMP passes, the port does not.
  it("lets TCP decide over ping", () => {
    expect(
      verdictOf(
        readings("ru", "ping", 3, 3),
        readings("ru", "tcp", 0, 3),
        readings("eu", "tcp", 3, 3),
      ),
    ).toBe("blocked");
  });

  // Measured 2026-09-08: check-host listed only two RU points that day,
  // and one of them reached the node.
  it("counts the points check-host listed, however few", () => {
    const result = summarize({
      readings: [
        ...readings("ru", "tcp", 1, 2),
        ...readings("eu", "tcp", 3, 3),
      ],
      requiredRegions: ["ru"],
    });

    expect(result.verdict).toBe("partial");
    expect(result.regions.map((region) => region.decisive)).toEqual([
      { region: "ru", required: true, method: "tcp", passed: 1, total: 2 },
      { region: "eu", required: false, method: "tcp", passed: 3, total: 3 },
    ]);
  });

  // The provider writes a point that gave no answer as a failed reading.
  it("counts a point that did not answer as one that failed", () => {
    const silent: ProbeReading = {
      ...(readings("ru", "tcp", 0, 1)[0] as ProbeReading),
      error: "no response",
    };

    expect(
      verdictOf(
        readings("ru", "tcp", 2, 2),
        [silent],
        readings("eu", "tcp", 3, 3),
      ),
    ).toBe("partial");
  });

  it("reads one required region fine and another cut off as partial", () => {
    const result = summarize({
      readings: [
        ...readings("ru", "tcp", 3, 3),
        ...readings("by", "tcp", 0, 3),
        ...readings("eu", "tcp", 3, 3),
      ],
      requiredRegions: ["ru", "by"],
    });

    expect(result.verdict).toBe("partial");
  });
});
