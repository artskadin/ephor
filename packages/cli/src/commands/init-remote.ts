import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_API_PORT } from "@ephorate/core";
import { stringify } from "yaml";
import { z } from "zod";
import { ApiError } from "../api-client";
import { cliFilePath, readCliFile } from "../cli-file";
import { UsageError } from "../exit-code";
import { RemoteCollector } from "../remote-collector";
import {
  BASHRC_FIRST_LINE,
  notOnPathMessage,
  runOverSsh,
} from "../remote-command";
import { lastLine, openTunnel } from "../tunnel";

interface InitRemoteOptions {
  /** The ssh alias, or `user@host`, of the machine running `ephor serve`. */
  remote: string;
  /** The config path here: `cli.yaml` goes beside it. */
  configPath: string;
  print: (line: string) => void;
  /** `ssh`; a test puts its own in place. */
  ssh?: string | undefined;
}

const AccessSchema = z
  .object({
    token: z.string().min(1),
    apiPort: z.number().int().min(1).max(65535),
    configPath: z.string().min(1),
  })
  .strict();

const ACCESS_TIMEOUT_MS = 30_000;

/**
 * Points the commands typed here at the collector on `remote`: asks it
 * for its API token over ssh and writes `cli.yaml`. Nothing is copied,
 * nothing here is removed: `rm cli.yaml` points them back.
 */
export async function runInitRemote(options: InitRemoteOptions): Promise<void> {
  const { remote, configPath, print } = options;
  const cliPath = cliFilePath(configPath);

  const existing = readCliFile(cliPath);
  if (existing !== undefined) {
    throw new UsageError(
      `${cliPath} already names ${existing.remote}: remove it to point at ${remote}`,
    );
  }

  const access = await askForAccess(options);

  mkdirSync(dirname(cliPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    cliPath,
    stringify({
      remote,
      token: access.token,
      ...(access.apiPort === DEFAULT_API_PORT
        ? {}
        : { apiPort: access.apiPort }),
    }),
    { flag: "wx", mode: 0o600 },
  );
  print(`created ${cliPath}: commands here now ask the collector on ${remote}`);

  print(await collectorAnswer(options, access));

  if (existsSync(configPath)) {
    print("");
    print(
      `${configPath} here is not used while ${cliPath} names ${remote}. ` +
        `To move it there, replacing the one \`ephor init\` wrote:`,
    );
    print(`  scp ${configPath} ${remote}:${access.configPath}`);
    print(
      `its \`ssh:\` entries then resolve on ${remote}, from its ~/.ssh; ` +
        "restart `ephor serve` there to read it.",
    );
  }
}

async function askForAccess(
  options: InitRemoteOptions,
): Promise<z.infer<typeof AccessSchema>> {
  const { remote } = options;
  const command = "ephor api-access";
  const result = await runOverSsh({
    remote,
    command,
    timeoutMs: ACCESS_TIMEOUT_MS,
    ssh: options.ssh,
  });

  if (result.code === 0) {
    try {
      // The last line: a login script there may print before ephor does.
      return AccessSchema.parse(JSON.parse(lastLine(result.stdout) ?? ""));
    } catch {
      throw new UsageError(
        `\`${command}\` on ${remote} answered something else than the API's ` +
          "token, port and config: is ephor there as new as here?",
      );
    }
  }

  const said = lastLine(result.stderr) ?? `exit code ${result.code}`;

  if (result.timedOut) {
    throw new UsageError(
      `no answer from \`${command}\` on ${remote} within ${ACCESS_TIMEOUT_MS / 1000} s: does a login ` +
        "script there wait for input?",
    );
  }
  if (result.code === 255) {
    throw new UsageError(`cannot reach ${remote} over ssh: ${said}`);
  }
  if (result.code === 127) {
    throw new UsageError(notOnPathMessage(remote, said));
  }
  if (said.includes("unknown command 'api-access'")) {
    throw new UsageError(
      `ephor on ${remote} is older than this one: update it there (npm i -g ephorate)`,
    );
  }

  if (said.includes("no API token here")) {
    throw new UsageError(
      `on ${remote}: ${said}; if \`ephor serve\` there runs with another ` +
        "config (a unit's EPHOR_CONFIG), export EPHOR_CONFIG=<its path> " +
        BASHRC_FIRST_LINE,
    );
  }

  throw new UsageError(`on ${remote}: ${said}`);
}

/** One line on whether the collector there answers; never a failure. */
async function collectorAnswer(
  options: InitRemoteOptions,
  access: z.infer<typeof AccessSchema>,
): Promise<string> {
  const collector = new RemoteCollector({
    remote: options.remote,
    remotePort: access.apiPort,
    token: access.token,
    tokenSource: cliFilePath(options.configPath),
    open: (tunnel) => openTunnel({ ...tunnel, command: options.ssh }),
  });

  try {
    const state = await collector.state();
    return `the collector on ${options.remote} answers: ${state.nodes.length} nodes`;
  } catch (error) {
    if (error instanceof ApiError && error.failure === "refused") {
      return `no \`ephor serve\` on ${options.remote} yet: start it there, then \`ephor status\` here`;
    }
    return `the collector on ${options.remote} did not answer yet: ${
      error instanceof Error ? error.message : String(error)
    }`;
  } finally {
    collector.close();
  }
}
