import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageError } from "../exit-code";
import { findToken, tokenPath } from "../token";

let directory: string;
let configPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ephor-token-"));
  configPath = join(directory, "config.yaml");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function writeToken(text: string, mode = 0o600): void {
  writeFileSync(tokenPath(configPath), text);
  chmodSync(tokenPath(configPath), mode);
}

describe("findToken", () => {
  it("lives beside the config", () => {
    expect(tokenPath(configPath)).toBe(join(directory, "token"));
  });

  it("takes EPHOR_TOKEN over the file", () => {
    writeToken("from-file");

    expect(
      findToken({ environment: { EPHOR_TOKEN: "from-env" }, configPath }),
    ).toEqual({ token: "from-env" });
  });

  it("reads the file, trimmed, when the variable is unset or empty", () => {
    writeToken("from-file\n");

    for (const environment of [{}, { EPHOR_TOKEN: "" }]) {
      expect(findToken({ environment, configPath })?.token).toBe("from-file");
    }
  });

  it("finds nothing when neither is there", () => {
    expect(findToken({ environment: {}, configPath })).toBeUndefined();
  });

  it("refuses an empty file, and one it cannot read, naming the path", () => {
    writeToken("  \n");
    expect(() => findToken({ environment: {}, configPath })).toThrow(
      UsageError,
    );
    expect(() => findToken({ environment: {}, configPath })).toThrow(
      `the token file ${tokenPath(configPath)} is empty`,
    );

    rmSync(tokenPath(configPath));
    mkdirSync(tokenPath(configPath));
    expect(() => findToken({ environment: {}, configPath })).toThrow(
      /cannot read .*token: EISDIR/,
    );
  });

  // As ssh does with a key: said, not refused.
  it("warns when others can read the file, and only then", () => {
    writeToken("secret", 0o644);
    expect(findToken({ environment: {}, configPath })?.warning).toBe(
      `${tokenPath(configPath)} is readable by others (mode 644): ` +
        `chmod 600 ${tokenPath(configPath)}`,
    );

    // Group-readable is the shared bastion's case: a panel's group.
    chmodSync(tokenPath(configPath), 0o640);
    expect(findToken({ environment: {}, configPath })?.warning).toContain(
      "(mode 640)",
    );

    chmodSync(tokenPath(configPath), 0o600);
    expect(findToken({ environment: {}, configPath })?.warning).toBeUndefined();

    chmodSync(tokenPath(configPath), 0o640);
    expect(
      findToken({ environment: {}, configPath, platform: "win32" })?.warning,
    ).toBeUndefined();
  });
});
