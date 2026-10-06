import { dirname, join } from "node:path";
import { parse, YAMLParseError } from "yaml";
import { z } from "zod";
import { UsageError } from "./exit-code";
import { readPrivateFile } from "./token";

// Where commands are typed when `ephor serve` runs elsewhere: the ssh
// alias of that machine, and the token its API wants.
const CliFileSchema = z
  .object({
    remote: z.string().min(1),
    token: z.string().min(1),
    /** The API's port there, when its `config.yaml` moved it. */
    apiPort: z.number().int().min(1).max(65535).default(31556),
  })
  .strict();

type CliFile = z.infer<typeof CliFileSchema>;

/** Beside `config.yaml`, so one directory holds what ephor keeps here. */
export function cliFilePath(configPath: string): string {
  return join(dirname(configPath), "cli.yaml");
}

/** `undefined` when there is no file: the collector is on this machine. */
export function readCliFile(
  path: string,
  platform?: NodeJS.Platform | undefined,
): (CliFile & { warning?: string | undefined }) | undefined {
  const file = readPrivateFile(path, platform);
  if (file === undefined) return undefined;

  let data: unknown;
  try {
    data = parse(file.text);
  } catch (error) {
    // Where, not what: the parser quotes the line, and it may be the token's.
    const where =
      error instanceof YAMLParseError && error.linePos !== undefined
        ? ` (line ${error.linePos[0].line})`
        : "";
    throw new UsageError(`${path} is not YAML${where}`);
  }

  const parsed = CliFileSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(top)"}: ${issue.message}`)
      .join("; ");
    throw new UsageError(`${path} is invalid: ${issues}`);
  }

  return { ...parsed.data, warning: file.warning };
}
