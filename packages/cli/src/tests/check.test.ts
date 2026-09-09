import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckResponse, NodeState, StateResponse } from "@ephorate/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ephor, type Run } from "./run-binary.js";
import { closedPortUrl, collectorOf, NOW, TOKEN } from "./test-server.js";

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

describe("ephor check through the daemon", () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  /** Two nodes, `system` and `reachability` reported at `ts` for each. */
  function stateReportedAt(ts: number): StateResponse {
    return {
      now: ts,
      nodes: ["achilles", "antilochus"].map((name) => ({
        node: name,
        status: "ok",
        reachability: "ok",
        probes: ["system", "reachability"],
        metrics: ["system.up", "reachability.up"].map((metric) => ({
          metric,
          probe: metric.split(".")[0] as string,
          status: "ok",
          severity: "ok",
          ok: true,
          ts,
          ageSeconds: 0,
          expectedEverySeconds: 60,
        })),
        reasons: [],
      })),
    };
  }

  it("posts the request and prints the daemon's result", async () => {
    const startedAt = NOW - 10;
    const finished = stateReportedAt(NOW);
    const collector = await collectorOf(finished, {
      check: { ...finished, startedAt, complete: true, pending: [] },
    });
    cleanups.push(collector.close);

    const run = await ephor(["check", "antilochus", "--json"], {
      EPHOR_API_URL: collector.url,
      EPHOR_TOKEN: TOKEN,
    });

    expect(run.code).toBe(0);
    expect(collector.requests).toMatchObject([
      { method: "POST", url: "/api/check", body: '{"node":"antilochus"}' },
    ]);
    const response = JSON.parse(run.stdout) as CheckResponse;
    expect(response.complete).toBe(true);
    expect(response.nodes.map((node) => node.node)).toEqual([
      "achilles",
      "antilochus",
    ]);
    expect(run.stderr).toBe("");
  });

  it("polls /api/state after an incomplete answer until every pair reported", async () => {
    const startedAt = NOW - 10;
    const before = stateReportedAt(startedAt - 60);
    const collector = await collectorOf(before, {
      check: {
        ...before,
        startedAt,
        complete: false,
        pending: ["achilles", "antilochus"],
      },
      // Two polls: still the old readings, then achilles alone.
      statesInOrder: [
        before,
        {
          ...before,
          nodes: [
            stateReportedAt(NOW).nodes[0] as NodeState,
            before.nodes[1] as NodeState,
          ],
        },
        stateReportedAt(NOW),
      ],
    });
    cleanups.push(collector.close);

    const run = await ephor(["check", "--json"], {
      EPHOR_API_URL: collector.url,
      EPHOR_TOKEN: TOKEN,
    });

    expect(run.code).toBe(0);
    expect(collector.requests.map((request) => request.url)).toEqual([
      "/api/check",
      "/api/state",
      "/api/state",
      "/api/state",
    ]);
    expect(run.stderr.split("\n").filter(Boolean)).toEqual([
      "still running on 2: achilles, antilochus",
      "still running on 1: antilochus",
    ]);
    const response = JSON.parse(run.stdout) as CheckResponse;
    expect(response).toMatchObject({ complete: true, pending: [] });
  }, 20_000);

  it("exits 2 with the daemon's words for a node it does not have", async () => {
    const collector = await collectorOf(stateReportedAt(NOW), {
      check: { status: 404, error: 'unknown node "hector"' },
    });
    cleanups.push(collector.close);

    const run = await ephor(["check", "hector"], {
      EPHOR_API_URL: collector.url,
      EPHOR_TOKEN: TOKEN,
    });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('unknown node "hector"');
  });

  it("runs here, saying so, when nothing listens on the port", async () => {
    const run = await ephor(["check", "--config", writeConfig(), "--json"], {
      EPHOR_API_URL: await closedPortUrl(),
      EPHOR_TOKEN: TOKEN,
    });

    expect(run.code).toBe(0);
    expect(run.stderr).toContain("ran once here, nothing recorded");
    expect(run.stderr).toContain("checking every node: every probe");
    const response = JSON.parse(run.stdout) as CheckResponse;
    expect(response.nodes.map((node) => node.node)).toEqual([
      "achilles",
      "antilochus",
    ]);
  });

  it("does not run here when the daemon is there and rejects the token", async () => {
    const collector = await collectorOf(stateReportedAt(NOW));
    cleanups.push(collector.close);

    const run = await ephor(["check", "--config", writeConfig()], {
      EPHOR_API_URL: collector.url,
      EPHOR_TOKEN: "wrong",
    });

    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("rejected the token");
    expect(run.stderr).not.toContain("checking");
  });
});
