import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { UsageError } from "./exit-code";

interface TokenSources {
  environment: Readonly<Record<string, string | undefined>>;
  /** The `config.yaml` in use: the token sits beside it. */
  configPath: string;
  platform?: NodeJS.Platform | undefined;
}

interface FoundToken {
  token: string;
  /** Said once by the caller: the file is readable by others. */
  warning?: string | undefined;
}

/** Beside `config.yaml`: one directory to back up, one to point a unit at. */
export function tokenPath(configPath: string): string {
  return join(dirname(configPath), "token");
}

/**
 * `EPHOR_TOKEN`, else the `token` file beside the config. `undefined` when
 * neither is there: the caller knows whether that is an error.
 */
export function findToken(sources: TokenSources): FoundToken | undefined {
  // An `export EPHOR_TOKEN=` left in a profile reads as not set.
  const fromEnvironment = sources.environment.EPHOR_TOKEN;
  if (fromEnvironment) return { token: fromEnvironment };

  const path = tokenPath(sources.configPath);
  let text: string;
  let mode: number;
  try {
    // One descriptor for both: the mode said is the file's that was read.
    const descriptor = openSync(path, "r");
    try {
      text = readFileSync(descriptor, "utf8");
      mode = fstatSync(descriptor).mode & 0o777;
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new UsageError(
      `cannot read the token at ${path}: ${messageOf(error)}`,
    );
  }

  const token = text.trim();
  if (token === "") {
    throw new UsageError(
      `the token file ${path} is empty: put the API token in it, or remove it`,
    );
  }

  return { token, warning: looseModeWarning(path, mode, sources.platform) };
}

// As ssh does with a key: a secret others can read is said out loud, but
// not refused; Windows has no such mode bits.
function looseModeWarning(
  path: string,
  mode: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "win32") return undefined;
  if ((mode & 0o077) === 0) return undefined;

  return (
    `${path} is readable by others (mode ${mode.toString(8)}): ` +
    `chmod 600 ${path}`
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
