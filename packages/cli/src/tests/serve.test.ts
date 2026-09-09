import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `ephor serve` as a process: the built binary on a config file, stopped
 * by real signals. Both probes are off, so nothing leaves the machine.
 */
const BINARY = fileURLToPath(new URL("../../bin/ephor.js", import.meta.url));
const TOKEN = "test-token";

/** A daemon takes ~0.3 s to listen here; vitest's default 5 s is for CI. */
const START_TIMEOUT_MS = 20_000;

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

let directory: string;
const running: ChildProcess[] = [];
const stderrOf = new WeakMap<ChildProcess, Buffer[]>();

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ephor-cli-serve-"));
});

afterEach(async () => {
  for (const child of running.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited(child);
    }
  }

  rmSync(directory, { recursive: true, force: true });
});

/**
 * The config schema refuses `port: 0`, so the daemon must be handed a
 * number: listen on 0 to have the OS pick a free port, read the number,
 * stop listening, return it.
 */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (address === null || typeof address === "string") {
        reject(new Error("no port was assigned"));
        return;
      }

      server.close(() => resolve(address.port));
    });
  });
}

/** Writes `config.yaml` into the test directory and returns its path. */
function writeConfig(apiSection: string): string {
  const path = join(directory, "config.yaml");

  writeFileSync(
    path,
    [
      "nodes:",
      "  - name: achilles",
      "    host: 203.0.113.10",
      "probes:",
      "  system: { enabled: false }",
      "  reachability: { enabled: false }",
      "storage:",
      `  path: ${join(directory, "metrics.db")}`,
      "api:",
      ...apiSection.split("\n").map((line) => `  ${line}`),
      "",
    ].join("\n"),
  );

  return path;
}

/** `ephor <words>` with only the given environment, killed after the test. */
function ephor(
  words: string[],
  environment: Record<string, string> = {},
): ChildProcess {
  const child = spawn(process.execPath, [BINARY, ...words], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.push(child);

  const chunks: Buffer[] = [];
  stderrOf.set(child, chunks);
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));

  return child;
}

function stderr(child: ChildProcess): string {
  return Buffer.concat(stderrOf.get(child) ?? []).toString();
}

function exited(child: ChildProcess): Promise<Exit> {
  return new Promise((resolve) => {
    child.on("close", (code, signal) =>
      resolve({ code, signal, stderr: stderr(child) }),
    );
  });
}

async function health(port: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

/** Polls until the API answers; a daemon that never listens fails the test. */
async function listening(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the daemon exited early:\n${stderr(child)}`);
    }

    const answered = await health(port)
      .then((response) => response.ok)
      .catch(() => false);
    if (answered) return;

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`nothing listened on ${port} within 10 s`);
}

describe("ephor serve", () => {
  it.each(["SIGTERM", "SIGINT", "SIGHUP"] as const)(
    "serves the API until %s, then exits 0 with the port closed",
    async (signal) => {
      const port = await pickFreePort();
      const configPath = writeConfig(`port: ${port}`);

      const child = ephor(["serve", "--config", configPath], {
        EPHOR_TOKEN: TOKEN,
      });
      await listening(port, child);

      child.kill(signal);
      const exit = await exited(child);

      expect(exit).toMatchObject({ code: 0, signal: null });
      const refused = await health(port).catch((error: unknown) => error);
      expect(refused).toMatchObject({ cause: { code: "ECONNREFUSED" } });
    },
    START_TIMEOUT_MS,
  );

  it(
    "reads the config path from EPHOR_CONFIG",
    async () => {
      const port = await pickFreePort();
      const configPath = writeConfig(`port: ${port}`);

      const child = ephor(["serve"], {
        EPHOR_TOKEN: TOKEN,
        EPHOR_CONFIG: configPath,
      });
      await listening(port, child);

      child.kill("SIGTERM");
      expect((await exited(child)).code).toBe(0);
    },
    START_TIMEOUT_MS,
  );

  it("exits 2 without a token, saying which variable", async () => {
    const configPath = writeConfig("enabled: true");

    const exit = await exited(ephor(["serve", "--config", configPath]));

    expect(exit.code).toBe(2);
    expect(exit.stderr).toContain("EPHOR_TOKEN is not set");
  });

  it("exits 2 on a config it cannot read", async () => {
    const exit = await exited(
      ephor(["serve", "--config", join(directory, "missing.yaml")], {
        EPHOR_TOKEN: TOKEN,
      }),
    );

    expect(exit.code).toBe(2);
    expect(exit.stderr).toContain("Cannot read config file");
    expect(exit.stderr).toContain(join(directory, "missing.yaml"));
  });

  it("exits 2 on a bad EPHOR_LOG_LEVEL, without a stack", async () => {
    const exit = await exited(
      ephor(["serve", "--config", writeConfig("enabled: false")], {
        EPHOR_LOG_LEVEL: "debgu",
      }),
    );

    expect(exit.code).toBe(2);
    expect(exit.stderr).toContain('Invalid log level "debgu"');
    expect(exit.stderr).not.toContain("    at ");
  });

  it(
    "exits 2 on a taken port, naming it",
    async () => {
      const port = await pickFreePort();
      const configPath = writeConfig(`port: ${port}`);
      const first = ephor(["serve", "--config", configPath], {
        EPHOR_TOKEN: TOKEN,
      });
      await listening(port, first);

      // Its own database: two daemons migrating one file would meet on the
      // write lock before either reaches the port.
      const exit = await exited(
        ephor(["serve", "--config", configPath], {
          EPHOR_TOKEN: TOKEN,
          EPHOR_DB: join(directory, "second.db"),
        }),
      );

      expect(exit.code).toBe(2);
      expect(exit.stderr).toContain(`127.0.0.1:${port} is taken`);
      expect(exit.stderr).not.toContain("    at ");
    },
    START_TIMEOUT_MS,
  );
});
