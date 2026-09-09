import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckResponse } from "@ephorate/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ephor, type Run } from "./run-binary.js";

/**
 * `ephor check` as a process, without a daemon. The nodes' ssh targets do
 * not resolve, so `system` fails in milliseconds and nothing leaves the
 * machine; `reachability` is off for the same reason.
 */
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ephor-cli-check-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function writeConfig(): string {
  const path = join(directory, "config.yaml");

  writeFileSync(
    path,
    [
      "nodes:",
      "  - name: achilles",
      "    host: 203.0.113.10",
      "    ssh: achilles.invalid",
      "  - name: antilochus",
      "    host: 203.0.113.11",
      "    ssh: antilochus.invalid",
      "probes:",
      "  reachability: { enabled: false }",
      // A DNS failure counts as transient: without this, two retries and
      // their sleeps make every run three seconds.
      "  system: { retries: 0, timeout: 2s }",
      "",
    ].join("\n"),
  );

  return path;
}

/** `ephor check <words>` on the test config, with an empty environment. */
function check(words: string[]): Promise<Run> {
  return ephor(["check", "--config", writeConfig(), ...words]);
}

describe("ephor check", () => {
  it("runs the probes here and prints the outcome as JSON", async () => {
    const run = await check(["--json"]);

    expect(run.code).toBe(0);
    const response = JSON.parse(run.stdout) as CheckResponse;
    expect(response).toMatchObject({ complete: true, pending: [] });
    expect(response.nodes.map((node) => node.node)).toEqual([
      "achilles",
      "antilochus",
    ]);
    expect(response.nodes[0]).toMatchObject({
      status: "warn",
      probes: ["system"],
    });
    // The real ssh failed, not a missing ssh binary.
    expect(response.nodes[0]?.reasons.join("\n")).toContain(
      "Could not resolve hostname",
    );
  });

  it("draws only the node asked for; JSON keeps every node", async () => {
    const table = await check(["antilochus", "--plain"]);

    expect(table.code).toBe(0);
    expect(table.stdout).toContain("! antilochus");
    expect(table.stdout).not.toContain("achilles");

    const json = await check(["antilochus", "--json"]);
    const response = JSON.parse(json.stdout) as CheckResponse;
    expect(response.nodes.map((node) => node.node)).toEqual([
      "achilles",
      "antilochus",
    ]);
  });

  it("says what it is about to check on stderr, the table on stdout", async () => {
    const run = await check([]);

    expect(run.code).toBe(0);
    expect(run.stderr).toContain("checking every node: every probe");
    expect(run.stdout).toMatch(/^NODE\s+LOAD/);
    expect(run.stdout).toContain("! achilles");
    expect(run.stdout).toContain("! antilochus");
  });

  it("exits 2 on a node the config does not have, listing those it has", async () => {
    const run = await check(["hector"]);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain('unknown node "hector"');
    expect(run.stderr).toContain("achilles");
  });

  it("exits 2 on a probe it does not know", async () => {
    const run = await check(["--probe", "speed"]);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('unknown probe "speed"');
  });

  it("exits 2 when the probe asked for is switched off", async () => {
    const run = await check(["--probe", "reachability"]);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("reachability is disabled");
  });

  it("exits 2 on a config it cannot read, without a stack", async () => {
    const run = await ephor([
      "check",
      "--config",
      join(directory, "missing.yaml"),
    ]);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Cannot read config file");
    expect(run.stderr).not.toContain("    at ");
  });
});
