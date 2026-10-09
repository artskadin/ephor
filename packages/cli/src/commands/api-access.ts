import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_API_PORT } from "@ephorate/core";
import { parse } from "yaml";
import { findToken } from "../token";

interface ApiAccessOptions {
  configPath: string;
  environment: Readonly<Record<string, string | undefined>>;
  print: (line: string) => void;
}

/**
 * What `init --remote` on another machine needs from this one: the API's
 * token (null when there is none yet) and port, the config they came
 * from and how many nodes it lists, by this machine's own rules. Run over
 * ssh, never typed.
 */
export function runApiAccess(options: ApiAccessOptions): void {
  const { configPath, environment } = options;
  const found = findToken({ environment, configPath });

  options.print(
    JSON.stringify({
      token: found?.token ?? null,
      apiPort: apiPortIn(configPath),
      configPath,
      nodes: nodeCountIn(configPath),
      configHash: contentHashOf(configPath),
    }),
  );
}

// From the YAML as written, not the full schema: a config that does not
// validate yet still says where its API listens.
export function apiPortIn(configPath: string): number {
  const port = (writtenConfig(configPath) as { api?: { port?: unknown } })?.api
    ?.port;
  return typeof port === "number" ? port : DEFAULT_API_PORT;
}

/**
 * As written: `ephor init`'s template lists none. `null` when the file is
 * there but not YAML: it may list nodes nobody can count.
 */
export function nodeCountIn(configPath: string): number | null {
  if (!existsSync(configPath)) return 0;
  let data: unknown;
  try {
    data = parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
  const nodes = (data as { nodes?: unknown } | null)?.nodes;
  return Array.isArray(nodes) ? nodes.length : 0;
}

/** sha256 of the bytes, to tell two copies apart; `null` with no file. */
export function contentHashOf(configPath: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(configPath)).digest("hex");
  } catch {
    return null;
  }
}

function writtenConfig(configPath: string): unknown {
  try {
    return parse(readFileSync(configPath, "utf8"));
  } catch {
    return undefined;
  }
}
