import { describe, expect, it } from "vitest";
import { colourEnabled } from "../colour-mode.js";

describe("colourEnabled", () => {
  it("colours a terminal that has not asked for none", () => {
    expect(
      colourEnabled({ plain: false, isTerminal: true, environment: {} }),
    ).toBe(true);
    expect(
      colourEnabled({
        plain: false,
        isTerminal: true,
        environment: { NO_COLOR: "" },
      }),
    ).toBe(true);
  });

  it("obeys --plain, NO_COLOR and a stdout that is not a terminal", () => {
    expect(
      colourEnabled({ plain: true, isTerminal: true, environment: {} }),
    ).toBe(false);
    expect(
      colourEnabled({
        plain: false,
        isTerminal: true,
        environment: { NO_COLOR: "1" },
      }),
    ).toBe(false);
    expect(
      colourEnabled({ plain: false, isTerminal: false, environment: {} }),
    ).toBe(false);
  });
});
