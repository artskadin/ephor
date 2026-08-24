import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ConfigSchema, type Config } from "./schema.js";

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

export async function loadConfig(path: string): Promise<Config> {
  let raw: string;

  try {
    raw = await readFile(path, "utf-8");
  } catch (cause) {
    throw new ConfigError(`Cannot read config file`, path, cause);
  }

  let data: unknown;

  try {
    data = parseYaml(raw);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);

    throw new ConfigError(`Invalid YAML syntax: \n\n${detail}`, path, cause);
  }

  const result = ConfigSchema.safeParse(data);

  if (!result.success) {
    throw new ConfigError(
      `Configuration is invalid:\n\n${formatIssue(result.error)}`,
      path,
      result.error,
    );
  }

  return result.data;
}

function formatIssue(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";

      return `  ${where}\n    ${issue.message}`;
    })
    .join("\n\n");
}
