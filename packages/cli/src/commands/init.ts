import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { UsageError } from "../exit-code";
import { tokenPath } from "../token";
import { CONFIG_TEMPLATE } from "./config-template";

interface InitOptions {
  /** `--config`, else `EPHOR_CONFIG`, else the default: where `serve` reads. */
  configPath: string;
  /** Said when set: it wins over the file written here. */
  environmentToken: string | undefined;
  print: (line: string) => void;
}

/**
 * Writes `config.yaml` from the template and a fresh API token beside it.
 * Never overwrites: what is there is kept, so running it again, or after
 * an upgrade that adds the token file, is safe.
 */
export function runInit(options: InitOptions): void {
  const { configPath, print } = options;
  const token = tokenPath(configPath);

  // Owner only: the token sits here, and the config names the servers.
  makeDirectory(dirname(configPath));

  const wroteConfig = writeNew(configPath, CONFIG_TEMPLATE, 0o644);
  // 32 random bytes, hex: as `openssl rand -hex 32`.
  const wroteToken = writeNew(
    token,
    `${randomBytes(32).toString("hex")}\n`,
    0o600,
  );

  print(
    wroteConfig ? `created ${configPath}` : `kept ${configPath}: already there`,
  );
  print(
    wroteToken
      ? `created ${token}, the API token, readable by you only`
      : `kept ${token}: already there`,
  );
  if (options.environmentToken) {
    print("note: EPHOR_TOKEN is set in this shell and wins over the file");
  }

  print("");
  print(
    wroteConfig
      ? `next: add your servers under \`nodes:\` in ${configPath}, then`
      : "next:",
  );
  print("  ephor check    probe every node once, right here");
  print("  ephor serve    keep measuring; `ephor watch` in another tab");
}

function makeDirectory(path: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new UsageError(`cannot create ${path}: ${messageOf(error)}`);
  }
}

/** `false` when the file is already there; `wx` makes that check atomic. */
function writeNew(path: string, text: string, mode: number): boolean {
  try {
    writeFileSync(path, text, { flag: "wx", mode });
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return false;
    }
    throw new UsageError(`cannot write ${path}: ${messageOf(error)}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
