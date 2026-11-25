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
      countryCode: region,
      network: "datacenter",
    };

    return { vantage, method, ok: index < passed };
  });
}

function verdictOf(...groups: ProbeReading[][]) {
  return summarize({
    readings: groups.flat(),
    regions: { targets: ["ru"], control: ["de"] },
    method: "tcp",
  }).verdict;
}

describe("summarize", () => {
  it.each([
    [3, "ok"],
    [2, "partial"],
    [1, "partial"],
    [0, "blocked"],
  ] as const)("reads %i of 3 RU points, DE all, as %s", (passed, verdict) => {
    expect(
      verdictOf(readings("ru", "tcp", passed, 3), readings("de", "tcp", 3, 3)),
    ).toBe(verdict);
  });

  it("calls it down when the control group fails too", () => {
    expect(
      verdictOf(readings("ru", "tcp", 0, 3), readings("de", "tcp", 0, 3)),
    ).toBe("down");
  });

  // One control point answering proves the server is up.
  it("calls it blocked when only part of the control group answers", () => {
    expect(
      verdictOf(readings("ru", "tcp", 0, 3), readings("de", "tcp", 1, 3)),
    ).toBe("blocked");
  });

  it("cannot tell blocked from down without a control group", () => {
    const result = summarize({
      readings: readings("ru", "tcp", 0, 3),
      regions: { targets: ["ru"], control: [] },
      method: "tcp",
    });
    expect(result.verdict).toBe("unknown");
    expect(result.regions[0]?.decisive).toMatchObject({ passed: 0, total: 3 });
  });

  it("does not count a reading from a different method", () => {
    expect(
      verdictOf(
        readings("ru", "http", 3, 3),
        readings("ru", "tcp", 0, 3),
        readings("de", "tcp", 3, 3),
      ),
    ).toBe("blocked");
  });

  // Measured 2026-09-08: check-host listed only two RU points that day,
  // and one of them reached the node.
  it("counts the points check-host listed, however few", () => {
    const result = summarize({
      readings: [
        ...readings("ru", "tcp", 1, 2),
        ...readings("de", "tcp", 3, 3),
      ],
      regions: { targets: ["ru"], control: ["de"] },
      method: "tcp",
    });

    expect(result.verdict).toBe("partial");
    expect(result.regions.map((region) => region.decisive)).toEqual([
      { region: "ru", required: true, method: "tcp", passed: 1, total: 2 },
      { region: "de", required: false, method: "tcp", passed: 3, total: 3 },
    ]);
  });

  it("does not count a missing result as either a pass or a measured failure", () => {
    const silent: ProbeReading = {
      ...(readings("ru", "tcp", 0, 1)[0] as ProbeReading),
      observed: false,
      error: "no response",
    };

    const result = summarize({
      regions: { targets: ["ru"], control: ["de"] },
      method: "tcp",
      readings: [
        ...readings("ru", "tcp", 2, 2),
        silent,
        ...readings("de", "tcp", 3, 3),
      ],
    });
    expect(result.verdict).toBe("unknown");
    expect(result.regions[0]?.decisive).toMatchObject({
      passed: 2,
      total: 3,
      reported: 2,
    });
  });

  it("cannot infer blocking from an unreported required region", () => {
    const unreported = readings("ru", "tcp", 0, 3).map(
      (reading): ProbeReading => ({
        ...reading,
        observed: false,
      }),
    );
    expect(verdictOf(unreported, readings("de", "tcp", 3, 3))).toBe("unknown");
  });

  it("cannot infer a wider outage from an unreported control region", () => {
    const unreported = readings("de", "tcp", 0, 3).map(
      (reading): ProbeReading => ({
        ...reading,
        observed: false,
      }),
    );
    expect(verdictOf(readings("ru", "tcp", 0, 3), unreported)).toBe("unknown");
  });

  it.each([
    { dePassed: 0, verdict: "unknown" },
    { dePassed: 1, verdict: "blocked" },
  ])(
    "keeps a missing control country separate when DE has $dePassed success",
    ({ dePassed, verdict }) => {
      const result = summarize({
        readings: [
          ...readings("ru", "tcp", 0, 2),
          ...readings("de", "tcp", dePassed, 1),
        ],
        regions: { targets: ["ru"], control: ["de", "nl"] },
        method: "tcp",
      });
      expect(result.verdict).toBe(verdict);
      expect(
        result.regions.map(({ decisive }) => [
          decisive.region,
          decisive.passed,
          decisive.total,
        ]),
      ).toEqual([
        ["ru", 0, 2],
        ["de", dePassed, 1],
        ["nl", 0, 0],
      ]);
    },
  );

  it.each([0, 3])(
    "does not infer an outage across RU and KZ from RU alone (control %i/3)",
    (controlPassed) => {
      const result = summarize({
        regions: { targets: ["ru", "kz"], control: ["de"] },
        method: "tcp",
        readings: [
          ...readings("ru", "tcp", 0, 3),
          ...readings("de", "tcp", controlPassed, 3),
        ],
      });
      expect(result.verdict).toBe("unknown");
    },
  );

  it.each([
    ["unknown", "has no readings", []],
    [
      "partial",
      "reports a timeout",
      readings("kz", "tcp", 0, 1).map((reading) => ({
        ...reading,
        error: "Connection timed out",
      })),
    ],
    ["ok", "passes", readings("kz", "tcp", 1, 1)],
  ] as const)(
    "returns %s when RU and DE pass and target KZ %s",
    (verdict, _description, kazakhstanReadings) => {
      const result = summarize({
        readings: [
          ...readings("ru", "tcp", 3, 3),
          ...kazakhstanReadings,
          ...readings("de", "tcp", 3, 3),
        ],
        regions: { targets: ["ru", "kz"], control: ["de"] },
        method: "tcp",
      });

      expect(result.verdict).toBe(verdict);
    },
  );
});
