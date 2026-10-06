import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliFilePath, readCliFile } from "../cli-file";
import { collectorSourceFrom } from "../client-config";
import { UsageError } from "../exit-code";

let directory: string;
let configPath: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ephor-cli-file-"));
  configPath = join(directory, "config.yaml");
  path = cliFilePath(configPath);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function write(text: string, mode = 0o600): void {
  writeFileSync(path, text);
  chmodSync(path, mode);
}

describe("readCliFile", () => {
  it("lives beside the config, and is not there by default", () => {
    expect(path).toBe(join(directory, "cli.yaml"));
    expect(readCliFile(path)).toBeUndefined();
  });

  it("reads the remote and the token, with the API's default port", () => {
    write("remote: bastion\ntoken: secret\n");

    expect(readCliFile(path)).toEqual({
      remote: "bastion",
      token: "secret",
      apiPort: 31556,
      warning: undefined,
    });
  });

  it.each([
    ["token: secret\n", /remote: Invalid input/],
    ["remote: bastion\n", /token: Invalid input/],
    ["remote: bastion\ntoken: secret\nport: 1\n", /Unrecognized key: "port"/],
    ["remote: bastion\ntoken: secret\napiPort: 0\n", /apiPort: Too small/],
    ["remote: [bastion\n", /is not YAML/],
  ])("refuses %j, naming the file", (text, message) => {
    write(text);

    expect(() => readCliFile(path)).toThrow(UsageError);
    expect(() => readCliFile(path)).toThrow(message);
    expect(() => readCliFile(path)).toThrow(path);
  });

  // It holds the token: the same rule as the token file.
  it("warns when others can read it", () => {
    write("remote: bastion\ntoken: secret\n", 0o644);

    expect(readCliFile(path)?.warning).toBe(
      `${path} is readable by others (mode 644): chmod 600 ${path}`,
    );
  });
});

describe("collectorSourceFrom", () => {
  it("is here without a cli.yaml", () => {
    expect(
      collectorSourceFrom({ EPHOR_TOKEN: "secret" }, configPath).kind,
    ).toBe("here");
  });

  it("is the remote cli.yaml names, with its token", () => {
    write("remote: bastion\ntoken: from-file\napiPort: 41556\n");

    expect(collectorSourceFrom({}, configPath)).toEqual({
      kind: "remote",
      remote: "bastion",
      remotePort: 41556,
      token: "from-file",
      tokenSource: path,
      warning: undefined,
    });
  });

  it("takes EPHOR_TOKEN over the file's token, and says so on rejection", () => {
    write("remote: bastion\ntoken: from-file\n");

    expect(
      collectorSourceFrom({ EPHOR_TOKEN: "from-env" }, configPath),
    ).toMatchObject({ token: "from-env", tokenSource: "EPHOR_TOKEN" });
  });

  // Scripts and tests name the collector outright.
  it("is the address EPHOR_API_URL names, whatever cli.yaml says", () => {
    write("remote: bastion\ntoken: from-file\n");

    expect(
      collectorSourceFrom(
        { EPHOR_API_URL: "http://127.0.0.1:41556", EPHOR_TOKEN: "secret" },
        configPath,
      ),
    ).toMatchObject({
      kind: "here",
      config: { apiUrl: "http://127.0.0.1:41556" },
    });
  });
});

describe("readCliFile on broken YAML", () => {
  // The parser quotes the line it choked on, and it may be the token's.
  it("says where, not what", () => {
    const directory = mkdtempSync(join(tmpdir(), "ephor-cli-yaml-"));
    const path = join(directory, "cli.yaml");
    writeFileSync(path, 'remote: bastion\ntoken: "s3cret-unclosed\n', {
      mode: 0o600,
    });

    try {
      expect(() => readCliFile(path)).toThrow(`${path} is not YAML (line `);
      expect(() => readCliFile(path)).not.toThrow(/s3cret/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
