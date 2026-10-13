import { createRegistry } from "@ephorate/collector";
import { describe, expect, it } from "vitest";
import { UsageError } from "../exit-code";
import {
  checkRequestFrom,
  collectProbeNames,
  PROBE_NAMES,
} from "../probe-selection";

describe("PROBE_NAMES", () => {
  // The copy exists so --help does not load the collector; this keeps it true.
  it("is the registry's list, in its order", () => {
    expect(PROBE_NAMES).toEqual(createRegistry().names());
  });
});

describe("collectProbeNames", () => {
  it("takes a comma list and a repeated flag alike", () => {
    const repeated = collectProbeNames("speed", collectProbeNames("system"));

    expect(collectProbeNames("system, speed")).toEqual(["system", "speed"]);
    expect(repeated).toEqual(["system", "speed"]);
  });
});

describe("checkRequestFrom", () => {
  it("sends one name as `probe`, which an older serve knows", () => {
    expect(checkRequestFrom("achilles", { probe: ["system"] })).toEqual({
      node: "achilles",
      probe: "system",
    });
    expect(
      checkRequestFrom(undefined, { probe: ["system", "system"] }),
    ).toEqual({ probe: "system" });
  });

  it("sends several as `probes` and a skip as `skip`", () => {
    expect(checkRequestFrom(undefined, { probe: ["system", "speed"] })).toEqual(
      { probes: ["system", "speed"] },
    );
    expect(checkRequestFrom(undefined, { skip: ["speed"] })).toEqual({
      skip: ["speed"],
    });
    expect(checkRequestFrom(undefined, {})).toEqual({});
  });

  it("refuses both flags at once, and an empty name", () => {
    expect(() =>
      checkRequestFrom(undefined, { probe: ["system"], skip: ["speed"] }),
    ).toThrow(UsageError);
    expect(() => checkRequestFrom(undefined, { skip: ["speed", ""] })).toThrow(
      /--skip takes probe names, separated by commas/,
    );
  });
});
