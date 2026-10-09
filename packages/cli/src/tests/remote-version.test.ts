import { describe, expect, it } from "vitest";
import { incompatibilityText, versionWarning } from "../remote-version";

describe("versions here and there", () => {
  it("says nothing when they match", () => {
    expect(versionWarning("bastion", "0.2.0", "0.2.0")).toBeUndefined();
  });

  // The older one is updated, to the newer one's version, wherever it is.
  it("warns with the command for the older one, there or here", () => {
    expect(versionWarning("bastion", "0.1.0", "0.2.0")).toBe(
      "warning: bastion has ephor 0.1.0, this computer ephor 0.2.0. It " +
        "works, but keep them the same; update it on bastion:\n" +
        "  ssh bastion npm i -g ephorate@0.2.0",
    );
    expect(versionWarning("bastion", "1.0.0", "0.9.3")).toBe(
      "warning: bastion has ephor 1.0.0, this computer ephor 0.9.3. It " +
        "works, but keep them the same; update it on this computer:\n" +
        "  npm i -g ephorate@1.0.0",
    );
  });

  it("compares by number, not as text", () => {
    expect(versionWarning("bastion", "0.10.0", "0.9.0")).toContain(
      "update it on this computer",
    );
  });

  it("puts the command to copy on the last line, alone", () => {
    const text = incompatibilityText("bastion", "0.1.0", "0.2.0");

    expect(text).toBe(
      "bastion has ephor 0.1.0, this computer ephor 0.2.0. Update it on " +
        "bastion, then run this again:\n  ssh bastion npm i -g ephorate@0.2.0",
    );
  });

  // A link lost reads no version either: no claim which one is older.
  it("says the version there could not be read, and how to level it", () => {
    expect(incompatibilityText("bastion", undefined, "0.2.0")).toBe(
      "The version of ephor on bastion could not be read; this computer " +
        "has ephor 0.2.0. Update it on bastion, then run this again:\n" +
        "  ssh bastion npm i -g ephorate@0.2.0",
    );
  });

  // semver: a release is newer than its candidates, rc.10 than rc.9.
  it("orders suffixes as semver does", () => {
    expect(versionWarning("bastion", "1.0.0", "1.0.0-rc.1")).toContain(
      "update it on this computer:\n  npm i -g ephorate@1.0.0",
    );
    expect(versionWarning("bastion", "1.0.0-rc.1", "1.0.0")).toContain(
      "update it on bastion",
    );
    expect(versionWarning("bastion", "1.0.0-rc.10", "1.0.0-rc.9")).toContain(
      "update it on this computer",
    );
  });

  it("names another build when the versions read the same", () => {
    expect(incompatibilityText("bastion", "0.2.0", "0.2.0")).toContain(
      "as this computer does, yet a different build",
    );
  });

  // ssh took the address as typed; a shell must get it as one word.
  it("keeps an ssh:// address as typed, and quotes an odd one", () => {
    expect(
      incompatibilityText("ssh://bruce@203.0.113.5:3948", "0.1.0", "0.2.0"),
    ).toContain("ssh ssh://bruce@203.0.113.5:3948 npm i -g ephorate@0.2.0");
    expect(incompatibilityText("my bastion", "0.1.0", "0.2.0")).toContain(
      "ssh 'my bastion' npm i -g",
    );
    // Measured: zsh globs `[…]`, "no matches found".
    expect(incompatibilityText("bruce@[::1]", "0.1.0", "0.2.0")).toContain(
      "ssh 'bruce@[::1]' npm i -g",
    );
  });
});
