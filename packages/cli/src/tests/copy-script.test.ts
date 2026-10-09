import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyScript } from "../commands/init-remote";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
});

/** The script as the remote runs it: the real `sh`, the config on stdin. */
function copy(path: string, sent: string, declared = Buffer.byteLength(sent)) {
  return spawnSync("sh", ["-c", copyScript(path, declared)], {
    input: sent,
    encoding: "utf8",
  });
}

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "ephor-copy-"));
  directories.push(path);
  return path;
}

describe("the config's copy there", () => {
  it("puts it in place and keeps what was there as .bak", () => {
    const path = join(directory(), "config.yaml");
    writeFileSync(path, "# template\n");

    const result = copy(path, "nodes:\n  - name: mine ü\n");

    expect(result.status).toBe(0);
    expect(readFileSync(path, "utf8")).toBe("nodes:\n  - name: mine ü\n");
    expect(readFileSync(`${path}.bak`, "utf8")).toBe("# template\n");
  });

  // A link cut mid-way ends `cat` with exit 0: the count is what tells.
  it("keeps the config as it was when the copy arrives cut short", () => {
    const path = join(directory(), "config.yaml");
    writeFileSync(path, "# template\n");
    const whole = "nodes:\n  - name: a\n  - name: b\n";

    const result = copy(path, whole.slice(0, 20), Buffer.byteLength(whole));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("the copy arrived cut short");
    expect(readFileSync(path, "utf8")).toBe("# template\n");
  });

  it("writes through a symlinked config, leaving the link", () => {
    const home = directory();
    const target = join(home, "dotfiles-config.yaml");
    const path = join(home, "config.yaml");
    writeFileSync(target, "# template\n");
    symlinkSync(target, path);

    copy(path, "nodes: []\n");

    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("nodes: []\n");
  });
});
