import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, createLogger } from "@ephorate/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MissingTokenError } from "../api/server.js";
import { type Daemon, serve } from "../serve.js";

/**
 * The real entry point: a config file on disk, a database file, the API
 * on a real port. Both probes are off, so nothing leaves the process.
 */
const TOKEN = "test-token";

const quiet = createLogger({ write: () => undefined });

let directory: string;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ephor-serve-"));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
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

/** Started on `configPath`, stopped after the test. */
async function start(configPath: string, token: string): Promise<Daemon> {
  const daemon = await serve({ configPath, token, logger: quiet });
  cleanups.push(daemon.stop);

  return daemon;
}

/**
 * A picked port can be taken back before the daemon binds it, by another
 * test worker or an outgoing connection: retry with a new one.
 */
async function startWithApi(): Promise<{ daemon: Daemon; url: string }> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await pickFreePort();
    const configPath = writeConfig(`port: ${port}`);

    try {
      const daemon = await start(configPath, TOKEN);

      return { daemon, url: `http://127.0.0.1:${port}` };
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("EADDRINUSE"))) {
        throw error;
      }

      lastError = error;
    }
  }

  throw lastError;
}

async function health(url: string): Promise<Response> {
  return fetch(`${url}/api/health`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

describe("serve", () => {
  it("answers /api/health on the configured port and closes it on stop", async () => {
    const { daemon, url } = await startWithApi();

    expect(daemon.apiUrl).toBe(url);
    const response = await health(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      nodes: 1,
      probes: ["system", "reachability"],
    });

    await daemon.stop();

    const refused = await health(url).catch((error: unknown) => error);
    expect(refused).toMatchObject({ cause: { code: "ECONNREFUSED" } });
  });

  it("stops once, however many times stop() is called", async () => {
    const { daemon, url } = await startWithApi();

    await Promise.all([daemon.stop(), daemon.stop()]);
    await expect(daemon.stop()).resolves.toBeUndefined();

    const refused = await health(url).catch((error: unknown) => error);
    expect(refused).toMatchObject({ cause: { code: "ECONNREFUSED" } });
  });

  it("runs without an API under api.enabled: false", async () => {
    const daemon = await start(writeConfig("enabled: false"), "");

    expect(daemon.apiUrl).toBeUndefined();
  });

  it("puts the database at storage.path", async () => {
    await start(writeConfig("enabled: false"), "");

    expect(existsSync(join(directory, "metrics.db"))).toBe(true);
  });

  it("puts the database where databasePath says, over storage.path", async () => {
    const configPath = writeConfig("enabled: false");
    const databasePath = join(directory, "elsewhere", "metrics.db");

    const daemon = await serve({
      configPath,
      databasePath,
      token: "",
      logger: quiet,
    });
    cleanups.push(daemon.stop);

    expect(existsSync(databasePath)).toBe(true);
    expect(existsSync(join(directory, "metrics.db"))).toBe(false);
  });

  it("refuses an empty token while the API is enabled", async () => {
    const configPath = writeConfig("enabled: true");

    await expect(start(configPath, "")).rejects.toThrow(MissingTokenError);
  });

  it("reports a bad config as ConfigError", async () => {
    const configPath = join(directory, "config.yaml");
    writeFileSync(configPath, "nodes: []\n");

    await expect(start(configPath, TOKEN)).rejects.toThrow(ConfigError);
  });

  it("fails with EADDRINUSE on a taken port, leaving its owner untouched", async () => {
    const { url } = await startWithApi();

    // The same file: the port the first daemon holds.
    await expect(start(join(directory, "config.yaml"), TOKEN)).rejects.toThrow(
      /EADDRINUSE/,
    );

    // The first daemon still answers: the second closed only its own.
    expect((await health(url)).status).toBe(200);
  });
});
