import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import type { ProbeDescriptor } from "../types/probe-contract.js";
import { buildConfigSchema, type Config } from "./schema.js";

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly path: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Validates already-parsed data. Kept separate from file reading so tests
 * and `ephor init` can check a config they hold in memory.
 */
export function parseConfig(
  data: unknown,
  descriptors: readonly ProbeDescriptor[],
  path = "(inline)",
): Config {
  const result = buildConfigSchema(descriptors).safeParse(data);

  if (!result.success) {
    throw new ConfigError(
      `Configuration is invalid:\n\n${formatIssues(result.error)}`,
      path,
      result.error,
    );
  }

  return result.data;
}

export async function loadConfig(
  path: string,
  descriptors: readonly ProbeDescriptor[],
): Promise<Config> {
  let raw: string;

  try {
    raw = await readFile(path, "utf-8");
  } catch (cause) {
    throw new ConfigError("Cannot read config file", path, cause);
  }

  let data: unknown;

  try {
    data = parseYaml(raw);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);

    throw new ConfigError(`Invalid YAML syntax:\n\n${detail}`, path, cause);
  }

  return parseConfig(data, descriptors, path);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";

      return `  ${where}\n    ${issue.message}`;
    })
    .join("\n\n");
}
