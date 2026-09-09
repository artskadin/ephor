import { afterEach, describe, expect, it } from "vitest";
import { ephor } from "./run-binary.js";
import { closedPortUrl, collectorOf, stateOf, TOKEN } from "./test-server.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("ephor status", () => {
  it("prints the collector's state as JSON on stdout, and nothing else there", async () => {
    const state = stateOf({ name: "achilles", status: "ok" });
    const collector = await collectorOf(state);
    cleanups.push(collector.close);

    const run = await ephor(["status", "--json"], {
      EPHOR_API_URL: collector.url,
      EPHOR_TOKEN: TOKEN,
    });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(state);
    expect(run.stderr).toBe("");
  });

  it("prints the table without --json, plain when stdout is a pipe", async () => {
    const collector = await collectorOf(
      stateOf(
        { name: "achilles", status: "ok" },
        { name: "german", status: "critical" },
      ),
    );
    cleanups.push(collector.close);

    const run = await ephor(["status"], {
      EPHOR_API_URL: collector.url,
      EPHOR_TOKEN: TOKEN,
    });
    const lines = run.stdout.split("\n");

    expect(run.code).toBe(0);
    expect(lines[0]).toMatch(/^NODE\s+REACH\s+LOAD/);
    expect(lines).toContain("  german is critical");
    expect(run.stdout).not.toContain("\u001b");
    expect(run.stderr).toBe("");
  });

  // The code says the command did its job, not how the fleet is: a
  // terminal that reacts to it (Warp paints the block red) would otherwise
  // call every answer on a fleet with one warn a failure.
  it("exits 0 when a node is not ok: the state is the answer, not the code", async () => {
    const collector = await collectorOf(
      stateOf(
        { name: "achilles", status: "ok" },
        { name: "german", status: "critical" },
      ),
    );
    cleanups.push(collector.close);

    const run = await ephor(["status", "--json"], {
      EPHOR_API_URL: collector.url,
      EPHOR_TOKEN: TOKEN,
    });

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).nodes).toHaveLength(2);
  });

  it("exits 2 without a token, and says which token it wants", async () => {
    const run = await ephor(["status", "--json"]);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/EPHOR_TOKEN is not set/);
  });

  it("exits 2 when the collector is not there, and says where it looked", async () => {
    const url = await closedPortUrl();

    const run = await ephor(["status", "--json"], {
      EPHOR_API_URL: url,
      EPHOR_TOKEN: TOKEN,
    });

    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(`cannot reach the collector at ${url}`);
  });

  it("exits 2 when the collector rejects the token", async () => {
    const collector = await collectorOf(stateOf());
    cleanups.push(collector.close);

    const run = await ephor(["status", "--json"], {
      EPHOR_API_URL: collector.url,
      EPHOR_TOKEN: "wrong",
    });

    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/rejected the token/);
  });
});

describe("ephor", () => {
  it("explains itself on --help, exit 0, for the program and for a command", async () => {
    const program = await ephor(["--help"]);
    const command = await ephor(["status", "--help"]);

    expect(program.code).toBe(0);
    expect(program.stdout).toMatch(/status/);
    expect(command.code).toBe(0);
    expect(command.stdout).toMatch(/--json/);
  });

  it("tells its version, exit 0", async () => {
    const run = await ephor(["--version"]);

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  // Commander's own refusals exit 1 by default, a code the contract does not
  // use: a refusal is a tool error like any other, 2. With a token in the
  // environment, the refusal can only be Commander's.
  it("exits 2 on a command or option it does not have, saying which", async () => {
    const command = await ephor(["frobnicate"], { EPHOR_TOKEN: TOKEN });
    const option = await ephor(["status", "--nope"], { EPHOR_TOKEN: TOKEN });

    expect(command.code).toBe(2);
    expect(command.stderr).toMatch(/unknown command 'frobnicate'/);
    expect(option.code).toBe(2);
    expect(option.stderr).toMatch(/unknown option '--nope'/);
    expect(command.stdout + option.stdout).toBe("");
  });

  it("exits 2 with the usage when given nothing to do", async () => {
    const run = await ephor([], { EPHOR_TOKEN: TOKEN });

    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/Usage: ephor/);
  });
});
