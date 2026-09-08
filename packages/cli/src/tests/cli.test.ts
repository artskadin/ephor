import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { closedPortUrl, collectorOf, stateOf, TOKEN } from "./test-server.js";

/**
 * The built binary, as `npm i -g ephorate` would install it. Built by
 * `pnpm typecheck` (`tsc --build`), which is why that runs before the tests.
 */
const BINARY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `ephor <words>` as a child process with only the given environment:
 * node is started by its own path, and nothing from this shell may leak in.
 * A child that died by a signal or never started reports -1, so it cannot
 * pass for a clean exit.
 */
function ephor(
  words: string[],
  environment: Record<string, string> = {},
): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BINARY, ...words],
      { env: environment },
      (error, stdout, stderr) => {
        let code = 0;

        if (error !== null) {
          code = typeof error.code === "number" ? error.code : -1;
        }

        resolve({ code, stdout, stderr });
      },
    );
  });
}

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

  it("exits 1 when a node is not ok, with the state still printed", async () => {
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

    expect(run.code).toBe(1);
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

  // Commander's own refusals exit 1 by default; 1 is what the contract
  // gives to node problems, and a script must be able to tell the two apart.
  // With a token in the environment, the refusal can only be Commander's.
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
