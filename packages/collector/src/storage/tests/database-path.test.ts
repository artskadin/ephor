import { describe, expect, it } from "vitest";
import { resolveDatabasePath } from "../database-path.js";

const posix = {
  platform: "linux" as const,
  home: "/home/bruce",
  environment: {},
};

describe("resolveDatabasePath", () => {
  it("prefers the environment over everything else", () => {
    expect(
      resolveDatabasePath({
        ...posix,
        fromEnvironment: "/data/metrics.db",
        fromConfig: "/etc/other.db",
      }),
    ).toBe("/data/metrics.db");
  });

  it("uses the configured path when the environment is silent", () => {
    expect(
      resolveDatabasePath({ ...posix, fromConfig: "/srv/ephor/metrics.db" }),
    ).toBe("/srv/ephor/metrics.db");
  });

  it("falls back to the XDG data directory", () => {
    expect(resolveDatabasePath(posix)).toBe(
      "/home/bruce/.local/share/ephor/metrics.db",
    );
  });

  it("honours XDG_DATA_HOME when it is set", () => {
    expect(
      resolveDatabasePath({
        ...posix,
        environment: { XDG_DATA_HOME: "/var/lib/data" },
      }),
    ).toBe("/var/lib/data/ephor/metrics.db");
  });

  it("uses LOCALAPPDATA on Windows", () => {
    expect(
      resolveDatabasePath({
        platform: "win32",
        home: "C:\\Users\\bruce",
        environment: { LOCALAPPDATA: "C:\\Users\\bruce\\AppData\\Local" },
      }),
    ).toBe("C:\\Users\\bruce\\AppData\\Local\\ephor\\metrics.db");
  });

  // The fallback exists because a relative path silently follows the working
  // directory: in a container that means the mounted volume is bypassed and
  // every metric is lost on the next recreation, with nothing to see.
  it("never returns a relative path", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const path = resolveDatabasePath({
        platform,
        home: platform === "win32" ? "C:\\Users\\bruce" : "/home/bruce",
        environment: {},
      });

      expect(path.startsWith(".")).toBe(false);
    }
  });
});
