import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import type { ProbeDescriptor } from "../types/probe-contract";
import { buildConfigSchema, type Config, NODE_NAME_FORM } from "./schema";

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
      `Configuration is invalid${where}:\n\n${formatIssues(result.error, data)}`,
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

function formatIssues(error: z.ZodError, data: unknown): string {
  return error.issues
    .map((issue) => {
      const lines = isMultiline(issue)
        ? issue.message.split("\n")
        : [issue.message];
      const body = lines
        .map((line) => (line === "" ? "" : `    ${printable(line)}`))
        .join("\n");
      return `  ${printable(configLocation(issue.path, data))}\n${body}`;
    })
    .join("\n\n");
}

// Set only on a message built from no text of the file's own.
function isMultiline(issue: z.ZodError["issues"][number]): boolean {
  return (
    issue.code === "custom" &&
    (issue.params as { isMultiline?: unknown } | undefined)?.isMultiline ===
      true
  );
}

// Keys and names from the file reach the terminal in paths and messages: a
// region named with an escape would recolour it, a newline forge a line.
function printable(text: string): string {
  return [...text]
    .map((character) =>
      isControlCharacter(character)
        ? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
        : character,
    )
    .join("");
}

function isControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

// `node odysseus: bandwidth`, not `nodes.3.bandwidth`: a person finds a
// node in the file by its name, not by counting from zero.
function configLocation(path: readonly PropertyKey[], data: unknown): string {
  const [section, index, ...rest] = path;
  if (section !== "nodes" || typeof index !== "number") {
    return path.length > 0 ? path.join(".") : "(root)";
  }

  const node = nodeLabel(data, index);
  return rest.length > 0 ? `${node}: ${rest.join(".")}` : node;
}

// The name only when it is a valid one: a refused name may hold a newline
// or an escape, printed to a terminal. A repeated one gets its number.
function nodeLabel(data: unknown, index: number): string {
  const nodes = (data as { nodes?: unknown } | null)?.nodes;
  const names = Array.isArray(nodes)
    ? nodes.map((node) => (node as { name?: unknown } | null)?.name)
    : [];
  const name = names[index];
  const position = `#${index + 1}`;

  if (typeof name !== "string" || !NODE_NAME_FORM.test(name)) {
    return `node ${position}`;
  }
  const isRepeated = names.filter((other) => other === name).length > 1;
  return isRepeated ? `node ${name} (${position})` : `node ${name}`;
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
