import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_API_PORT } from "@ephorate/core";
import { stringify } from "yaml";
import { z } from "zod";
import { ApiError } from "../api-client";
import { cliFilePath, readCliFile } from "../cli-file";
import { UsageError } from "../exit-code";
import { RemoteCollector } from "../remote-collector";
import { lastLine, openTunnel } from "../tunnel";

interface InitRemoteOptions {
  /** The ssh alias, or `user@host`, of the machine running `ephor serve`. */
  remote: string;
  /** Its `config.yaml`, when its `serve` runs with another (a unit's). */
  remoteConfig?: string | undefined;
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
  })
  .strict();

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
    const there = options.remoteConfig ?? ".config/ephor/config.yaml";
    print("");
    print(
      `${configPath} here is not used while ${cliPath} names ${remote}. ` +
        `To move it there, replacing the one \`ephor init\` wrote:`,
    );
    print(`  scp ${configPath} ${remote}:${there}`);
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
  const command = `ephor api-access${
    options.remoteConfig === undefined
      ? ""
      : ` --config ${quoteForShell(options.remoteConfig)}`
  }`;
  const result = await runOverSsh(options.ssh ?? "ssh", remote, command);

  if (result.code === 0) {
    try {
      // The last line: a login script there may print before ephor does.
      return AccessSchema.parse(JSON.parse(lastLine(result.stdout) ?? ""));
    } catch {
      throw new UsageError(
        `\`${command}\` on ${remote} answered something else than the API's ` +
          "token and port: is ephor there as new as here?",
      );
    }
  }

  const said = lastLine(result.stderr) ?? `exit code ${result.code}`;

  if (result.timedOut) {
    throw new UsageError(
      `no answer from \`${command}\` on ${remote} within 30 s: does a login ` +
        "script there wait for input?",
    );
  }
  if (result.code === 255) {
    throw new UsageError(`cannot reach ${remote} over ssh: ${said}`);
  }
  // 127 is the shell's "not found": nvm's PATH is not loaded over ssh.
  if (result.code === 127) {
    throw new UsageError(
      `ephor or node is not on ${remote}'s PATH for commands run over ` +
        `ssh (${said}): install ephor there (npm i -g ephorate). With node ` +
        "in a home directory (nvm, a tarball), set its PATH on the first " +
        "line of ~/.bashrc there: Debian's returns early for the " +
        "non-interactive shell ssh runs commands in",
    );
  }
  if (said.includes("unknown command 'api-access'")) {
    throw new UsageError(
      `ephor on ${remote} is older than this one: update it there (npm i -g ephorate)`,
    );
  }

  if (said.includes("no API token here")) {
    throw new UsageError(
      `on ${remote}: ${said}; if \`ephor serve\` there runs with another ` +
        "config (a unit's EPHOR_CONFIG), name it with --remote-config",
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

function runOverSsh(
  ssh: string,
  remote: string,
  command: string,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolve) => {
    execFile(
      ssh,
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "LogLevel=ERROR",
        "-o",
        "ControlPath=none",
        "--",
        remote,
        command,
      ],
      { timeout: 30_000 },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof error.code === "number"
              ? error.code
              : 255;
        resolve({
          code,
          stdout,
          stderr: stderr || (error?.message ?? ""),
          timedOut: error?.killed === true,
        });
      },
    );
  });
}

// One word for the remote shell, whatever the path holds.
function quoteForShell(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}
