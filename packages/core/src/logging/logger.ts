/**
 * Structured logging for a process nobody is watching.
 *
 * The collector runs for weeks without a terminal, so the only account of
 * what it did is what it wrote down. That account has to be filterable
 * (levels), machine-readable when it lands in journald or `docker logs`
 * (JSON), and readable by a person during development (columns and colour).
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export const LOG_LEVELS: readonly LogLevel[] = [
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

/**
 * Spellings this level is known by elsewhere. syslog, Python and Go all
 * call it "warning", so it is the value an operator is most likely to type
 * — and rejecting it teaches nothing.
 */
const LEVEL_ALIASES: Readonly<Record<string, LogLevel>> = { warning: "warn" };

export type LogFields = Readonly<Record<string, unknown>>;

/** Keys a field may not occupy in the JSON output; see formatJson. */
const RESERVED_KEYS: readonly string[] = ["ts", "level", "msg"];

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds these fields to every message, including its own children. */
  child(fields: LogFields): Logger;
}

export type LogFormat = "json" | "pretty";

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

/** Everything a logger and its children share; resolved once. */
interface LoggerCore {
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

  const core: LoggerCore = {
    minimumRank: LEVEL_RANK[level],
    format,
    color:
      options.color ??
      (format === "pretty" && isTerminal && !prefersNoColor(environment)),
    now: options.now ?? Date.now,
    // stderr, not stdout: `ephor status --json | jq` must keep stdout as a
    // clean data channel. Both journald and docker capture stderr anyway.
    write: options.write ?? ((line) => void process.stderr.write(`${line}\n`)),
  };

  return new StructuredLogger(core, {});
}

/**
 * Throws on an unrecognised value rather than falling back to a default.
 * `EPHOR_LOG_LEVEL=debgu` means the operator believes debug logging is on;
 * silently leaving it off is the worst of the available answers.
 */
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
    private readonly core: LoggerCore,
    private readonly bound: LogFields,
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
    return new StructuredLogger(this.core, { ...this.bound, ...fields });
  }

  private log(
    level: Exclude<LogLevel, "silent">,
    message: string,
    fields?: LogFields,
  ): void {
    if (LEVEL_RANK[level] < this.core.minimumRank) return;

    const merged = fields ? { ...this.bound, ...fields } : this.bound;
    const time = this.core.now();

    this.core.write(
      this.core.format === "json"
        ? formatJson(time, level, message, merged)
        : formatPretty(this.core, time, level, message, merged),
    );
  }
}

function formatJson(
  time: number,
  level: LogLevel,
  message: string,
  fields: LogFields,
): string {
  // Reserved keys first, so a raw line reads left to right, and a field
  // named `msg` cannot displace the message a log parser looks for. Such a
  // field is kept under a prefixed name rather than dropped: it is a
  // mistake worth seeing, not worth losing.
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
    // A circular or otherwise unserialisable field must never take the
    // process down. Losing the fields beats losing the daemon.
    return JSON.stringify({
      ts: record.ts,
      level,
      msg: message,
      fieldsError: "not serialisable",
    });
  }
}

function formatPretty(
  core: LoggerCore,
  time: number,
  level: LogLevel,
  message: string,
  fields: LogFields,
): string {
  const stamp = formatLocalTime(new Date(time));
  const label = level.toUpperCase().padEnd(5);

  const head = core.color
    ? `${paint(stamp, "90")} ${paint(label, LEVEL_COLOR[level as Exclude<LogLevel, "silent">] ?? "0")}`
    : `${stamp} ${label}`;

  const pairs: string[] = [];
  const stacks: string[] = [];

  for (const [key, value] of Object.entries(fields)) {
    // Optional fields are common; printing `rtt=undefined` is noise, and
    // JSON.stringify drops them too, so both formats stay in step.
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

/**
 * Own properties are copied along with the standard ones. Node's system
 * errors carry the fields actually worth filtering on — `code`, `errno`,
 * `syscall`, `path` — and none of them appear in `name` or `message`
 * reliably; `ECONNREFUSED` and `EHOSTUNREACH` are different diagnoses.
 *
 * `cause` is left as-is: JSON.stringify walks into it and applies the
 * replacer again, so a nested Error is described the same way, and a cyclic
 * chain is caught by the serialiser rather than by recursion here.
 */
function describeError(error: Error): Record<string, unknown> {
  const described: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };

  // `message` and `stack` are non-enumerable on Error, so this adds only
  // what a subclass or Node itself attached.
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

/** Written as an escape sequence rather than a literal control byte,
 * which is invisible in a diff and easy to lose in an edit. */
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
