import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ephor } from "./run-binary";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "ephor-access-"));
  directories.push(path);
  return path;
}

describe("ephor access-targets", () => {
  it("lists the enabled nodes reached over ssh, with their alias", async () => {
    const config = join(directory(), "config.yaml");
    writeFileSync(
      config,
      [
        "nodes:",
        "  - name: achilles",
        "    host: 203.0.113.10",
        "    ssh: achilles",
        "  - name: hector",
        "    host: 203.0.113.11",
        "    ssh: { user: bruce, port: 3948 }",
        "  - name: priam",
        "    host: 203.0.113.12",
        "  - name: paris",
        "    host: 203.0.113.13",
        "    ssh: paris",
        "    enabled: false",
        "",
      ].join("\n"),
    );

    const run = await ephor(["access-targets", "--config", config]);

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      nodes: [{ node: "achilles", alias: "achilles" }, { node: "hector" }],
    });
  });

  it("exits 2 with the config's own words when it does not parse", async () => {
    const config = join(directory(), "config.yaml");
    writeFileSync(config, "nodes: [{ name: achilles }]\n");

    const run = await ephor(["access-targets", "--config", config]);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("host");
    expect(run.stderr).not.toContain("    at ");
  });
});

describe("ephor setup-access", () => {
  it("exits 2 without a cli.yaml, saying what names a collector", async () => {
    const config = join(directory(), "config.yaml");

    const run = await ephor(["setup-access", "--config", config]);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("`ephor init --remote <host>` names one");
  });
});
