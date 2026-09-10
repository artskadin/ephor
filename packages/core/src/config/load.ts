import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import type { ProbeDescriptor } from "../types/probe-contract";
import { buildConfigSchema, type Config } from "./schema";

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

export function parseConfig(
  data: unknown,
  descriptors: readonly ProbeDescriptor[],
  path?: string,
): Config {
  const result = buildConfigSchema(descriptors).safeParse(data);

  if (!result.success) {
    const where = path === undefined ? "" : ` (${path})`;

    throw new ConfigError(
      `Configuration is invalid${where}:\n\n${formatIssues(result.error)}`,
      path ?? "(inline)",
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
    // Node's message carries the path: `ENOENT: ..., open '/etc/ephor/…'`.
    const detail = cause instanceof Error ? cause.message : String(cause);

    throw new ConfigError(`Cannot read config file: ${detail}`, path, cause);
  }

  let data: unknown;

  try {
    data = parseYaml(raw);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);

    throw new ConfigError(
      `Invalid YAML syntax (${path}):\n\n${detail}`,
      path,
      cause,
    );
  }

  return parseConfig(data, descriptors, path);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  ${issueLocation(issue)}\n    ${issue.message}`)
    .join("\n\n");
}

function issueLocation(issue: z.ZodError["issues"][number]): string {
  return issue.path.length > 0 ? issue.path.join(".") : "(root)";
}

/** One line, for an API error; `formatIssues` is the multi-line report. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issueLocation(issue)}: ${issue.message}`)
    .join("; ");
}
