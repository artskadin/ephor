import { readFileSync } from "node:fs";
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
 * token (null when there is none yet) and port, and the config they came
 * from, by this machine's own rules. Run over ssh, never typed.
 */
export function runApiAccess(options: ApiAccessOptions): void {
  const { configPath, environment } = options;
  const found = findToken({ environment, configPath });

  options.print(
    JSON.stringify({
      token: found?.token ?? null,
      apiPort: apiPortIn(configPath),
      configPath,
    }),
  );
}

// From the YAML as written, not the full schema: a config that does not
// validate yet still says where its API listens.
export function apiPortIn(configPath: string): number {
  let data: unknown;
  try {
    data = parse(readFileSync(configPath, "utf8"));
  } catch {
    return DEFAULT_API_PORT;
  }

  const port = (data as { api?: { port?: unknown } } | null)?.api?.port;
  return typeof port === "number" ? port : DEFAULT_API_PORT;
}
