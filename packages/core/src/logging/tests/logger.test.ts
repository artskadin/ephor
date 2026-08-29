import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createLogger,
  type Logger,
  type LoggerOptions,
  parseLogLevel,
} from "../logger.js";

/** A fixed instant so every assertion can name the exact timestamp. */
const AT = Date.parse("2026-08-29T04:00:00.031Z");

function capture(options: LoggerOptions = {}): {
  logger: Logger;
  lines: string[];
} {
  const lines: string[] = [];

  const logger = createLogger({
    format: "json",
    now: () => AT,
    write: (line) => lines.push(line),
    environment: {},
    isTerminal: false,
    ...options,
  });

  return { logger, lines };
}

function records(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("levels", () => {
  it("drops everything below the configured level", () => {
    const { logger, lines } = capture({ level: "warn" });

    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");

    expect(records(lines).map((record) => record.msg)).toEqual(["c", "d"]);
  });

  it("emits everything at debug", () => {
    const { logger, lines } = capture({ level: "debug" });

    logger.debug("a");
    logger.error("b");

    expect(lines).toHaveLength(2);
  });

  it("emits nothing at silent", () => {
    const { logger, lines } = capture({ level: "silent" });

    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");

    expect(lines).toEqual([]);
  });

  it("defaults to info", () => {
    const { logger, lines } = capture();

    logger.debug("hidden");
    logger.info("shown");

    expect(records(lines).map((record) => record.msg)).toEqual(["shown"]);
  });

  it("takes the level from the environment", () => {
    const { logger, lines } = capture({
      environment: { EPHOR_LOG_LEVEL: "error" },
    });

    logger.warn("hidden");
    logger.error("shown");

    expect(records(lines).map((record) => record.msg)).toEqual(["shown"]);
  });

  it("lets an explicit level win over the environment", () => {
    const { logger, lines } = capture({
      level: "debug",
      environment: { EPHOR_LOG_LEVEL: "error" },
    });

    logger.debug("shown");

    expect(lines).toHaveLength(1);
  });
});

describe("parseLogLevel", () => {
  it("accepts a known level in any casing, with spaces", () => {
    expect(parseLogLevel(" WARN ")).toBe("warn");
  });

  it("returns undefined when nothing is set", () => {
    expect(parseLogLevel(undefined)).toBeUndefined();
    expect(parseLogLevel("")).toBeUndefined();
  });

  // A typo means the operator believes debug logging is on. Leaving it
  // quietly off is the one outcome that helps nobody.
  it("rejects an unknown level and lists the valid ones", () => {
    expect(() => parseLogLevel("debgu")).toThrow(
      /Invalid log level "debgu".*debug, info, warn, error, silent/,
    );
  });

  // syslog, Python and Go all spell it "warning", so it is the value an
  // operator is most likely to type.
  it("accepts warning as a spelling of warn", () => {
    expect(parseLogLevel("warning")).toBe("warn");
    expect(parseLogLevel("WARNING")).toBe("warn");
  });
});

describe("json output", () => {
  it("writes timestamp, level, message and fields on one line", () => {
    const { logger, lines } = capture();

    logger.info("pruned old metrics", { removed: 412 });

    expect(records(lines)[0]).toEqual({
      ts: "2026-08-29T04:00:00.031Z",
      level: "info",
      msg: "pruned old metrics",
      removed: 412,
    });
    expect(lines[0]).not.toContain("\n");
  });

  // Otherwise one careless field silently rewrites what a log parser reads.
  it("does not let a field displace a reserved key", () => {
    const { logger, lines } = capture();

    logger.info("real", { msg: "fake", level: "error", ts: "1999" });

    expect(records(lines)[0]).toEqual({
      ts: "2026-08-29T04:00:00.031Z",
      level: "info",
      msg: "real",
      // Kept rather than dropped: a mistake worth seeing.
      "field.msg": "fake",
      "field.level": "error",
      "field.ts": "1999",
    });
  });

  it("puts the reserved keys first so a raw line reads left to right", () => {
    const { logger, lines } = capture();

    logger.info("probe finished", { node: "achilles" });

    expect(lines[0]).toMatch(/^\{"ts":"[^"]+","level":"info","msg":/);
  });

  it("omits fields that are undefined", () => {
    const { logger, lines } = capture();

    logger.info("probe finished", { rtt: undefined, durationMs: 12 });

    expect(records(lines)[0]).not.toHaveProperty("rtt");
  });

  it("describes an Error instead of rendering it as an empty object", () => {
    const { logger, lines } = capture();

    logger.error("failed", { cause: new TypeError("bad port") });

    const cause = records(lines)[0]?.cause as Record<string, unknown>;

    expect(cause.name).toBe("TypeError");
    expect(cause.message).toBe("bad port");
    expect(cause.stack).toContain("TypeError: bad port");
  });

  // `code` is the field a system error is diagnosed by: ECONNREFUSED and
  // EHOSTUNREACH are different problems, and neither is reliably spelled
  // out in the message.
  it("keeps the properties a system error carries", async () => {
    const { logger, lines } = capture();

    const failure = await readFile("/definitely/not/here").catch(
      (cause: unknown) => cause,
    );

    logger.error("config unreadable", { cause: failure });

    expect(records(lines)[0]?.cause).toMatchObject({
      name: "Error",
      code: "ENOENT",
      syscall: "open",
      path: "/definitely/not/here",
    });
  });

  it("keeps the properties of a custom error subclass", () => {
    const { logger, lines } = capture();

    class ConfigError extends Error {
      constructor(
        message: string,
        readonly path: string,
      ) {
        super(message);
        this.name = "ConfigError";
      }
    }

    logger.error("invalid", { cause: new ConfigError("bad", "/etc/x.yaml") });

    expect(records(lines)[0]?.cause).toMatchObject({
      name: "ConfigError",
      message: "bad",
      path: "/etc/x.yaml",
    });
  });

  it("keeps the standard fields alongside the extra ones", () => {
    const { logger, lines } = capture();
    const failure = Object.assign(new Error("connection refused"), {
      code: "ECONNREFUSED",
    });

    logger.error("x", { cause: failure });

    const described = records(lines)[0]?.cause as Record<string, unknown>;

    expect(described.name).toBe("Error");
    expect(described.message).toBe("connection refused");
    expect(described.code).toBe("ECONNREFUSED");
    expect(String(described.stack)).toContain("connection refused");
  });

  it("describes a nested cause the same way", () => {
    const { logger, lines } = capture();
    const inner = new Error("connection refused");

    logger.error("failed", {
      cause: new Error("probe failed", { cause: inner }),
    });

    const outer = records(lines)[0]?.cause as Record<string, unknown>;
    const nested = outer.cause as Record<string, unknown>;

    expect(nested.message).toBe("connection refused");
  });

  it("renders a bigint as a string rather than throwing", () => {
    const { logger, lines } = capture();

    logger.info("rows", { changes: 9007199254740993n });

    expect(records(lines)[0]?.changes).toBe("9007199254740993");
  });

  // Losing the fields beats losing the daemon.
  it("keeps the message when a field cannot be serialised", () => {
    const { logger, lines } = capture();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => logger.error("still logged", { cyclic })).not.toThrow();

    expect(records(lines)[0]).toEqual({
      ts: "2026-08-29T04:00:00.031Z",
      level: "error",
      msg: "still logged",
      fieldsError: "not serialisable",
    });
  });
});

describe("child loggers", () => {
  it("adds the bound fields to every message", () => {
    const { logger, lines } = capture();

    logger.child({ node: "achilles" }).info("probe finished");

    expect(records(lines)[0]?.node).toBe("achilles");
  });

  it("merges the fields of nested children", () => {
    const { logger, lines } = capture();

    logger
      .child({ node: "achilles" })
      .child({ probe: "system" })
      .info("probe finished");

    expect(records(lines)[0]).toMatchObject({
      node: "achilles",
      probe: "system",
    });
  });

  it("lets a call-site field override a bound one", () => {
    const { logger, lines } = capture();

    logger.child({ probe: "system" }).info("x", { probe: "reachability" });

    expect(records(lines)[0]?.probe).toBe("reachability");
  });

  it("does not leak fields back into the parent", () => {
    const { logger, lines } = capture();

    logger.child({ node: "achilles" }).info("child");
    logger.info("parent");

    expect(records(lines)[1]).not.toHaveProperty("node");
  });
});

describe("pretty output", () => {
  it("puts time, level, message and pairs on one line", () => {
    const { logger, lines } = capture({ format: "pretty", color: false });

    logger.warn("probe failed", { node: "achilles", durationMs: 1204 });

    expect(lines[0]).toBe(
      `${localStamp()} WARN  probe failed  node=achilles durationMs=1204`,
    );
  });

  it("quotes a value that would otherwise break the pairs apart", () => {
    const { logger, lines } = capture({ format: "pretty", color: false });

    logger.warn("probe failed", { detail: "Permission denied (publickey)" });

    expect(lines[0]).toContain('detail="Permission denied (publickey)"');
  });

  it("puts an error's stack on its own indented lines", () => {
    const { logger, lines } = capture({ format: "pretty", color: false });

    logger.error("crashed", { cause: new Error("boom") });

    const [head, ...rest] = lines[0]?.split("\n") ?? [];

    expect(head).toContain("cause=Error: boom");
    expect(rest[0]).toMatch(/^ {4}Error: boom/);
  });

  it("emits no escape sequences when colour is off", () => {
    const { logger, lines } = capture({ format: "pretty", color: false });

    logger.info("plain");

    expect(lines[0]).not.toContain("\u001b");
  });

  it("colours the level when colour is on", () => {
    const { logger, lines } = capture({ format: "pretty", color: true });

    logger.error("boom");

    expect(lines[0]).toContain("\u001b[31m");
  });
});

describe("defaults", () => {
  it("chooses pretty for a terminal and json otherwise", () => {
    const shared = { now: () => AT, environment: {} };
    const terminal: string[] = [];
    const piped: string[] = [];

    createLogger({
      ...shared,
      isTerminal: true,
      write: (line) => terminal.push(line),
    }).info("x");

    createLogger({
      ...shared,
      isTerminal: false,
      write: (line) => piped.push(line),
    }).info("x");

    expect(() => JSON.parse(piped[0] ?? "")).not.toThrow();
    expect(() => JSON.parse(terminal[0] ?? "")).toThrow();
  });

  it("honours NO_COLOR on a terminal", () => {
    const lines: string[] = [];

    createLogger({
      now: () => AT,
      isTerminal: true,
      environment: { NO_COLOR: "1" },
      write: (line) => lines.push(line),
    }).error("boom");

    expect(lines[0]).not.toContain("\u001b");
  });

  // The one decision the whole module turns on, and the one that injecting
  // `write` everywhere would otherwise leave untested: a log line on stdout
  // would corrupt `ephor status --json | jq`.
  it("writes to stderr and never to stdout", () => {
    const toStderr: string[] = [];
    const toStdout: string[] = [];

    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        toStderr.push(String(chunk));

        return true;
      });

    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        toStdout.push(String(chunk));

        return true;
      });

    try {
      createLogger({
        now: () => AT,
        environment: {},
        isTerminal: false,
      }).info("started");
    } finally {
      stderrWrite.mockRestore();
      stdoutWrite.mockRestore();
    }

    expect(toStdout).toEqual([]);
    expect(toStderr).toHaveLength(1);
    expect(toStderr[0]).toContain('"msg":"started"');
    // One line per record, newline included by the sink.
    expect(toStderr[0]?.endsWith("\n")).toBe(true);
  });

  it("treats an empty NO_COLOR as unset, per the convention", () => {
    const lines: string[] = [];

    createLogger({
      now: () => AT,
      isTerminal: true,
      environment: { NO_COLOR: "" },
      write: (line) => lines.push(line),
    }).error("boom");

    expect(lines[0]).toContain("\u001b");
  });
});

/** The pretty format prints local time, so the expectation must too. */
function localStamp(): string {
  const date = new Date(AT);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");

  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds(),
  )}.${pad(date.getMilliseconds(), 3)}`;
}
