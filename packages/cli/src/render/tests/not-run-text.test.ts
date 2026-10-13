import type { ProbeNotRun } from "@ephorate/core";
import { describe, expect, it } from "vitest";
import { notRunText } from "../not-run-text";

const off = (
  node: string,
  probe: string,
  disabledReason: ProbeNotRun["disabledReason"] = "config",
): ProbeNotRun => ({ node, probe, disabledReason });

describe("notRunText", () => {
  it("says nothing when everything asked for ran, or nothing was said", () => {
    expect(notRunText([], 3)).toBeUndefined();
    expect(notRunText(undefined, 3)).toBeUndefined();
  });

  it("names the nodes once per probe and reason, the reason once", () => {
    expect(
      notRunText(
        [
          off("german", "speed"),
          off("hector", "speed"),
          off("home-lab", "speed", "no-executor"),
          off("home-lab", "system", "no-executor"),
        ],
        4,
      ),
    ).toBe(
      "not run: speed on german, hector (off in the config); speed on " +
        "home-lab (no `ssh:` in the config); system on home-lab (no `ssh:` " +
        "in the config)",
    );
  });

  it("says every node when it is off on all of them for one reason", () => {
    expect(
      notRunText([off("achilles", "speed"), off("german", "speed")], 2),
    ).toBe("not run: speed on every node (off in the config)");
  });

  // `speed` on 2 of 200 nodes would otherwise list 198 names on every check.
  it("counts the nodes past a few", () => {
    const many = Array.from({ length: 198 }, (_, index) =>
      off(`node-${index}`, "speed"),
    );

    expect(notRunText(many, 200)).toBe(
      "not run: speed on 198 of 200 nodes (off in the config)",
    );
  });

  it("names the one node checked", () => {
    expect(notRunText([off("german", "speed")], 1)).toBe(
      "not run: speed on german (off in the config)",
    );
  });

  // Read off the wire after the table is drawn: a throw would print a stack.
  it("passes over broken entries and keeps a reason it does not know", () => {
    const wire: unknown = [
      null,
      {},
      { node: "german", probe: "speed", disabledReason: 7 },
      { node: "german", probe: "speed", disabledReason: "budget" },
    ];

    expect(notRunText(wire, 2)).toBe("not run: speed on german (budget)");
    expect(notRunText({ node: "german" }, 2)).toBeUndefined();
  });
});
