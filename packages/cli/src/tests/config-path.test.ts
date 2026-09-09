import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigPath } from "../config-path.js";

const posix = {
  platform: "linux" as const,
  home: "/home/bruce",
  environment: {},
};

describe("resolveConfigPath", () => {
  it("takes the flag as it is, over the environment", () => {
    expect(
      resolveConfigPath({
        ...posix,
        flag: "./examples/config.yaml",
        environment: { EPHOR_CONFIG: "/etc/ephor/config.yaml" },
      }),
    ).toBe("./examples/config.yaml");
  });

  it("takes EPHOR_CONFIG when there is no flag", () => {
    expect(
      resolveConfigPath({
        ...posix,
        environment: { EPHOR_CONFIG: "/etc/ephor/config.yaml" },
      }),
    ).toBe("/etc/ephor/config.yaml");
  });

  it("reads an empty EPHOR_CONFIG as not set", () => {
    expect(
      resolveConfigPath({ ...posix, environment: { EPHOR_CONFIG: "" } }),
    ).toBe("/home/bruce/.config/ephor/config.yaml");
  });

  it("falls back to the XDG config directory", () => {
    expect(resolveConfigPath(posix)).toBe(
      "/home/bruce/.config/ephor/config.yaml",
    );
  });

  it("honours XDG_CONFIG_HOME when it is set", () => {
    expect(
      resolveConfigPath({
        ...posix,
        environment: { XDG_CONFIG_HOME: "/etc/xdg" },
      }),
    ).toBe("/etc/xdg/ephor/config.yaml");
  });

  it("uses APPDATA on Windows", () => {
    expect(
      resolveConfigPath({
        platform: "win32",
        home: "C:\\Users\\bruce",
        environment: { APPDATA: "C:\\Users\\bruce\\AppData\\Roaming" },
      }),
    ).toBe("C:\\Users\\bruce\\AppData\\Roaming\\ephor\\config.yaml");
  });

  it("never returns a relative default", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const path = resolveConfigPath({
        platform,
        home: platform === "win32" ? "C:\\Users\\bruce" : "/home/bruce",
        environment: {},
      });

      expect(isAbsolute(path) || /^[A-Z]:\\/.test(path), path).toBe(true);
    }
  });
});
