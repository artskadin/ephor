import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  /** Said when set: it wins over the `cli.yaml` written here. */
  environmentToken: string | undefined;
  print: (line: string) => void;
  /** `ssh`; a test puts its own in place. */
  ssh?: string | undefined;
}

const AccessSchema = z
  .object({
    token: z.string().min(1).nullable(),
    apiPort: z.number().int().min(1).max(65535),
    configPath: z.string().min(1),
  })
  .strict();

// A login script waiting for input would hold a step forever.
const STEP_TIMEOUT_MS = 30_000;

/**
 * Sets up the collector on `remote` and points the commands typed here
 * at it, a line a step. Run again, it keeps what is done: `ephor init`
 * there keeps its files, and `cli.yaml` here is rewritten only if changed.
 */
export async function runInitRemote(options: InitRemoteOptions): Promise<void> {
  const { remote, configPath, print } = options;
  const cliPath = cliFilePath(configPath);

  const existing = readExisting(cliPath);
  if (existing !== undefined && existing.remote !== remote) {
    throw new UsageError(
      `${cliPath} already names ${existing.remote}: remove it to point at ${remote}`,
    );
  }

  let access = await askForAccess(options);
  if (access.token === null && (await isServedThere(options, access.apiPort))) {
    throw new UsageError(
      `${remote} has no token beside ${access.configPath}, yet an \`ephor ` +
        `serve\` answers on its port ${access.apiPort}: it runs with another ` +
        `config (a unit's EPHOR_CONFIG?). On ${remote}, export ` +
        `EPHOR_CONFIG=<its path> ${BASHRC_FIRST_LINE}; then run this again`,
    );
  }

  // Its own lines say what it made and what it kept; its advice is for
  // someone typing there.
  const prepared = await runThere(options, "ephor init");
  for (const line of prepared.split("\n")) {
    if (line.startsWith("created ") || line.startsWith("kept ")) {
      print(`${remote}: ${line}`);
    }
  }
  if (access.token === null) access = await askForAccess(options);
  const token = access.token;
  if (token === null) {
    throw new UsageError(
      `\`ephor init\` on ${remote} left no token beside ${access.configPath}`,
    );
  }

  if (
    existing !== undefined &&
    existing.token === token &&
    existing.apiPort === access.apiPort
  ) {
    print(`kept ${cliPath}: it already points here at ${remote}`);
  } else {
    mkdirSync(dirname(cliPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      cliPath,
      stringify({
        remote,
        token,
        ...(access.apiPort === DEFAULT_API_PORT
          ? {}
          : { apiPort: access.apiPort }),
      }),
    );
    print(
      `${existing === undefined ? "created" : "updated"} ${cliPath}: ` +
        `commands here now ask the collector on ${remote}`,
    );
  }
  // `mode` on a write applies only when the file is created.
  chmodSync(cliPath, 0o600);
  if (existing?.warning !== undefined) {
    print(`${cliPath}: now readable by you only, as the token in it must be`);
  }
  if (options.environmentToken) {
    print("note: EPHOR_TOKEN is set in this shell and wins over cli.yaml");
  }

  print(await collectorAnswer(options, { ...access, token }));

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
  const command = "ephor api-access";
  const stdout = await runThere(options, command);

  try {
    // The last line: a login script there may print before ephor does.
    return AccessSchema.parse(JSON.parse(lastLine(stdout) ?? ""));
  } catch {
    throw new UsageError(
      `\`${command}\` on ${options.remote} answered something else than the ` +
        "API's token, port and config: is ephor there as new as here?",
    );
  }
}

/** `command` on the remote: its stdout, or why it could not run there. */
async function runThere(
  options: InitRemoteOptions,
  command: string,
): Promise<string> {
  const { remote } = options;
  const result = await runOverSsh({
    remote,
    command,
    timeoutMs: STEP_TIMEOUT_MS,
    ssh: options.ssh,
  });
  if (result.code === 0) return result.stdout;

  const said = lastLine(result.stderr) ?? `exit code ${result.code}`;

  if (result.timedOut) {
    throw new UsageError(
      `no answer from \`${command}\` on ${remote} within ` +
        `${STEP_TIMEOUT_MS / 1000} s: does a login script there wait for input?`,
    );
  }
  if (result.code === 255) {
    throw new UsageError(`cannot reach ${remote} over ssh: ${said}`);
  }
  if (result.code === 127) {
    throw new UsageError(notOnPathMessage(remote, said));
  }
  if (said.includes(`unknown command '${command.split(" ")[1]}'`)) {
    throw new UsageError(
      `ephor on ${remote} is older than this one: update it there (npm i -g ephorate)`,
    );
  }
  throw new UsageError(`on ${remote}: ${said}`);
}

/** One line on whether the collector there answers; never a failure. */
async function collectorAnswer(
  options: InitRemoteOptions,
  access: { apiPort: number; token: string },
): Promise<string> {
  const collector = collectorThere(options, access);

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

// Measured: an ephor serve answers a wrong token 401. A serve there that
// this machine's rules cannot find runs on another config.
async function isServedThere(
  options: InitRemoteOptions,
  apiPort: number,
): Promise<boolean> {
  const collector = collectorThere(options, { apiPort, token: "none" });
  try {
    await collector.state();
    return true;
  } catch (error) {
    return error instanceof ApiError && error.failure === "unauthorized";
  } finally {
    collector.close();
  }
}

function collectorThere(
  options: InitRemoteOptions,
  access: { apiPort: number; token: string },
): RemoteCollector {
  return new RemoteCollector({
    remote: options.remote,
    remotePort: access.apiPort,
    token: access.token,
    tokenSource: cliFilePath(options.configPath),
    open: (tunnel) => openTunnel({ ...tunnel, command: options.ssh }),
  });
}

/** A file that will not parse is in the way, not a reason to stop blind. */
function readExisting(cliPath: string): ReturnType<typeof readCliFile> {
  try {
    return readCliFile(cliPath);
  } catch (error) {
    throw new UsageError(
      `${error instanceof Error ? error.message : String(error)}: remove it ` +
        "and run this again",
    );
  }
}
