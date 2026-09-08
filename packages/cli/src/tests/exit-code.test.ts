import { describe, expect, it } from "vitest";
import { exitCodeFor } from "../exit-code.js";
import { stateOf } from "./test-server.js";

describe("exitCodeFor", () => {
  it("is 0 only when every node is ok", () => {
    expect(exitCodeFor(stateOf({ name: "a", status: "ok" }).nodes)).toBe(0);
    expect(
      exitCodeFor(
        stateOf({ name: "a", status: "ok" }, { name: "b", status: "warn" })
          .nodes,
      ),
    ).toBe(1);
  });

  it.each(["warn", "stale", "critical", "unknown"] as const)(
    "counts a %s node as a problem",
    (status) => {
      expect(exitCodeFor(stateOf({ name: "a", status }).nodes)).toBe(1);
    },
  );

  it("finds nothing wrong with an empty fleet", () => {
    expect(exitCodeFor([])).toBe(0);
  });
});
