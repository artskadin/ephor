// JSON for journald and `docker logs`, columns and colour for a terminal.

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LOG_LEVELS: readonly LogLevel[] = [
  "debug",
  "info",
  "warn",
  "error",
  "silent",
];

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  // Above every message, so nothing is ever emitted.
  silent: 100,
};

const LEVEL_COLOR: Record<Exclude<LogLevel, "silent">, string> = {
  debug: "90",
  info: "36",
  warn: "33",
  error: "31",
};

// syslog, Python and Go all say "warning".
const LEVEL_ALIASES: Readonly<Record<string, LogLevel>> = { warning: "warn" };

export type LogFields = Readonly<Record<string, unknown>>;

/** Keys a field may not occupy in the JSON output; see `formatJson`. */
const RESERVED_KEYS: readonly string[] = ["ts", "level", "msg"];

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Adds these fields to every message, its own children included. */
  child(fields: LogFields): Logger;
}

type LogFormat = "json" | "pretty";

export interface LoggerOptions {
  level?: LogLevel | undefined;
  format?: LogFormat | undefined;
  color?: boolean | undefined;
  /** Epoch milliseconds. Injected so tests do not depend on the clock. */
  now?: (() => number) | undefined;
  /** Receives one finished line, without a trailing newline. */
  write?: ((line: string) => void) | undefined;
  environment?: Readonly<Record<string, string | undefined>> | undefined;
  /** Whether the sink is a terminal. Decides format and colour. */
  isTerminal?: boolean | undefined;
}

/** Shared by a logger and its children; resolved once. */
interface LoggerSettings {
  minimumRank: number;
  format: LogFormat;
  color: boolean;
  now: () => number;
  write: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const environment = options.environment ?? process.env;
  const isTerminal = options.isTerminal ?? Boolean(process.stderr.isTTY);

  const level =
    options.level ?? parseLogLevel(environment.EPHOR_LOG_LEVEL) ?? "info";
  const format = options.format ?? (isTerminal ? "pretty" : "json");

  const settings: LoggerSettings = {
    minimumRank: LEVEL_RANK[level],
    format,
    color:
      options.color ??
      (format === "pretty" && isTerminal && !prefersNoColor(environment)),
    now: options.now ?? Date.now,
    // stderr: `ephor status --json | jq` must keep stdout clean.
    write: options.write ?? ((line) => void process.stderr.write(`${line}\n`)),
  };

  return new StructuredLogger(settings, {});
}

/** Throws on `EPHOR_LOG_LEVEL=debgu`: silently leaving debug off is worse. */
export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (value === undefined || value.trim() === "") return undefined;

  const spelling = value.trim().toLowerCase();
  const candidate = LEVEL_ALIASES[spelling] ?? spelling;

  if (isLogLevel(candidate)) return candidate;

  throw new Error(
    `Invalid log level "${value}". Expected one of: ${LOG_LEVELS.join(", ")}`,
  );
}

class StructuredLogger implements Logger {
  constructor(
    private readonly settings: LoggerSettings,
    private readonly boundFields: LogFields,
  ) {}

  debug(message: string, fields?: LogFields): void {
    this.log("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.log("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.log("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.log("error", message, fields);
  }

  child(fields: LogFields): Logger {
    return new StructuredLogger(this.settings, {
      ...this.boundFields,
      ...fields,
    });
  }

  private log(
    level: Exclude<LogLevel, "silent">,
    message: string,
    fields?: LogFields,
  ): void {
    if (LEVEL_RANK[level] < this.settings.minimumRank) return;

    const merged = fields
      ? { ...this.boundFields, ...fields }
      : this.boundFields;
    const time = this.settings.now();

    this.settings.write(
      this.settings.format === "json"
        ? formatJson(time, level, message, merged)
        : formatPretty(this.settings, time, level, message, merged),
    );
  }
}

function formatJson(
  time: number,
  level: LogLevel,
  message: string,
  fields: LogFields,
): string {
  // A field named `msg` must not displace the message; it is kept prefixed.
  const record: Record<string, unknown> = {
    ts: new Date(time).toISOString(),
    level,
    msg: message,
  };

  for (const [key, value] of Object.entries(fields)) {
    record[RESERVED_KEYS.includes(key) ? `field.${key}` : key] = value;
  }

  try {
    return JSON.stringify(record, jsonReplacer);
  } catch {
    // Losing the fields beats losing the daemon.
    return JSON.stringify({
      ts: record.ts,
      level,
      msg: message,
      fieldsError: "not serialisable",
    });
  }
}

function formatPretty(
  settings: LoggerSettings,
  time: number,
  level: LogLevel,
  message: string,
  fields: LogFields,
): string {
  const stamp = formatLocalTime(new Date(time));
  const label = level.toUpperCase().padEnd(5);

  const head = settings.color
    ? `${paint(stamp, "90")} ${paint(label, LEVEL_COLOR[level as Exclude<LogLevel, "silent">] ?? "0")}`
    : `${stamp} ${label}`;

  const pairs: string[] = [];
  const stacks: string[] = [];

  for (const [key, value] of Object.entries(fields)) {
    // Dropped as JSON.stringify drops them, so both formats agree.
    if (value === undefined) continue;

    if (value instanceof Error) {
      pairs.push(`${key}=${value.name}: ${value.message}`);
      if (value.stack) stacks.push(indent(value.stack));
      continue;
    }

    pairs.push(`${key}=${renderValue(value)}`);
  }

  const tail = pairs.length > 0 ? `  ${pairs.join(" ")}` : "";
  const trace = stacks.length > 0 ? `\n${stacks.join("\n")}` : "";

  return `${head} ${message}${tail}${trace}`;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return describeError(value);
  // JSON.stringify throws on BigInt instead of skipping it.
  if (typeof value === "bigint") return value.toString();

  return value;
}

// Own properties too: Node's system errors carry `code`, `errno`, `syscall`
// there. `cause` is left for the replacer, which describes it the same way.
function describeError(error: Error): Record<string, unknown> {
  const described: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };

  for (const [key, value] of Object.entries(error)) {
    if (key in described) continue;
    described[key] = value;
  }

  if (error.stack) described.stack = error.stack;
  if (error.cause !== undefined) described.cause = error.cause;

  return described;
}

function renderValue(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
  }
  if (value === null || typeof value !== "object") return String(value);

  try {
    return JSON.stringify(value, jsonReplacer) ?? String(value);
  } catch {
    return "[not serialisable]";
  }
}

function formatLocalTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const millis = String(date.getMilliseconds()).padStart(3, "0");

  return `${hours}:${minutes}:${seconds}.${millis}`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line.trim()}`)
    .join("\n");
}

// An escape, not the byte: git would treat the file as binary.
const ESCAPE = "\u001b";

function paint(text: string, code: string): string {
  return `${ESCAPE}[${code}m${text}${ESCAPE}[0m`;
}

/** Per the NO_COLOR convention: present and non-empty disables colour. */
function prefersNoColor(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  const value = environment.NO_COLOR;

  return value !== undefined && value !== "";
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}
