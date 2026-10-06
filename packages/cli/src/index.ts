import { createRequire } from "node:module";
import { type CheckRequest, createLogger, type Logger } from "@ephorate/core";
import { Command, CommanderError } from "commander";
import { ApiClient, ApiError } from "./api-client";
import { cliFilePath, readCliFile } from "./cli-file";
import { ClientConfigError, collectorSourceFrom } from "./client-config";
import { exitQuietlyOnClosedPipe } from "./closed-pipe";
import { runStatus } from "./commands/status";
import { resolveConfigPath } from "./config-path";
import { EXIT_OK, EXIT_TOOL_ERROR, UsageError } from "./exit-code";
import { RemoteCollector } from "./remote-collector";
import { colourEnabled } from "./render/colour-mode";
import { findToken, tokenPath } from "./token";

const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

/** Closed when the command ends: an open tunnel's ssh holds the loop. */
const remoteCollectors: RemoteCollector[] = [];

exitQuietlyOnClosedPipe(process.stdout);
exitQuietlyOnClosedPipe(process.stderr);

// One binary, both roles: `serve` is the daemon, the rest its clients.
// A command that runs to its end has done its job; anything else is thrown.
const program = new Command("ephor")
  .description("Monitoring for self-hosted VPN nodes")
  .version(version)
  // Commander would exit 1 on a bad option; the contract has no 1.
  .exitOverride();

const CONFIG_OPTION = [
  "--config <path>",
  "config.yaml to run (default: EPHOR_CONFIG, else ~/.config/ephor/config.yaml)",
] as const;

program
  .command("serve")
  .description("Run the collector in the foreground until a signal")
  .option(...CONFIG_OPTION)
  .action(async (options: { config?: string }) => {
    // Imported on demand: loading the collector (fastify, node:sqlite)
    // takes 60 ms, and no other command needs it. `ephor --version` is
    // 160 ms in total.
    const { runServe } = await import("./commands/serve");
    const logger = loggerFromEnvironment();
    const configPath = resolveConfigPath({ flag: options.config });
    const found = findToken({ environment: process.env, configPath });
    if (found?.warning !== undefined) logger.warn(found.warning);

    await runServe({
      configPath,
      databasePath: process.env.EPHOR_DB,
      token: found?.token ?? "",
      tokenPath: tokenPath(configPath),
      logger,
    });
  });

program
  .command("init")
  .description(
    "Write config.yaml from a template and an API token beside it; keeps what is there",
  )
  .option(...CONFIG_OPTION)
  .option(
    "--remote <host>",
    "instead: point the commands here at `ephor serve` on this ssh host (writes cli.yaml)",
  )
  .action(async (options: { config?: string; remote?: string }) => {
    const configPath = resolveConfigPath({ flag: options.config });
    const print = (line: string) => void process.stdout.write(`${line}\n`);

    if (options.remote !== undefined) {
      const { runInitRemote } = await import("./commands/init-remote");
      await runInitRemote({ remote: options.remote, configPath, print });
      return;
    }

    const { runInit } = await import("./commands/init");
    runInit({
      configPath,
      environmentToken: process.env.EPHOR_TOKEN,
      print,
    });
  });

// Run over ssh by `init --remote` on another machine; it prints a secret.
program
  .command("api-access", { hidden: true })
  .option(...CONFIG_OPTION)
  .action(async (options: { config?: string }) => {
    const { runApiAccess } = await import("./commands/api-access");

    runApiAccess({
      configPath: resolveConfigPath({ flag: options.config }),
      environment: process.env,
      print: (line) => void process.stdout.write(`${line}\n`),
    });
  });

program
  .command("check")
  .description(
    "Run the probes once, through `ephor serve` when it is up, else here",
  )
  .argument("[node]", "one node instead of every node")
  .option("--probe <name>", "one probe instead of every probe")
  .option(...CONFIG_OPTION)
  .option("--json", "print the result as JSON")
  .option("--plain", "no colour, whatever the terminal")
  .action(
    async (
      node: string | undefined,
      options: {
        probe?: string;
        config?: string;
        json?: boolean;
        plain?: boolean;
      },
    ) => {
      const { runCheck } = await import("./commands/check");

      const request: CheckRequest = {};
      if (node !== undefined) request.node = node;
      if (options.probe !== undefined) request.probe = options.probe;

      const configPath = resolveConfigPath({ flag: options.config });

      await runCheck({
        configPath,
        request,
        // No daemon set up, here or remote: the probes run here.
        client: hasCollector(configPath)
          ? collectorClient(configPath)
          : undefined,
        ...outputFrom(options),
        logger: loggerFromEnvironment(),
        note: (line) => void process.stderr.write(`${line}\n`),
      });
    },
  );

program
  .command("status")
  .description("The state of every node, as the collector sees it")
  .option("--json", "print the collector's answer as JSON")
  .option("--plain", "no colour, whatever the terminal")
  .action(async (options: { json?: boolean; plain?: boolean }) => {
    const client = collectorClient();

    await runStatus({ client, ...outputFrom(options) });
  });

program
  .command("ack")
  .description("Acknowledge a node's problem: `watch` keeps quiet about it")
  .argument("<node>", "the node, as named in config.yaml")
  .option("--note <text>", "why, shown beside the node (one line)")
  .option("--for <duration>", "an end whatever the node does: 30m, 12h, 3d")
  .option(
    "--until-ok",
    "last until the node is ok, not until its status changes",
  )
  .option("--clear", "remove the node's acknowledgement instead")
  .option("--json", "print the collector's answer as JSON")
  .addHelpText(
    "after",
    [
      "",
      "By default the acknowledgement covers the status the node has now: any",
      "change is news again. --until-ok covers every status short of ok.",
      "Acknowledging again replaces the old one whole: without --until-ok it",
      "becomes the default kind, for the status the node has then.",
    ].join("\n"),
  )
  .action(
    async (
      node: string,
      options: {
        note?: string;
        for?: string;
        untilOk?: boolean;
        clear?: boolean;
        json?: boolean;
      },
    ) => {
      const { acknowledgeRequestFrom, runAck } = await import("./commands/ack");
      const clearing = options.clear ?? false;

      if (
        clearing &&
        (options.note !== undefined ||
          options.for !== undefined ||
          options.untilOk !== undefined)
      ) {
        throw new UsageError(
          "--clear removes the acknowledgement: --note, --for and --until-ok do not go with it",
        );
      }

      const request = clearing ? undefined : acknowledgeRequestFrom(options);

      await runAck({
        client: collectorClient(),
        node,
        request,
        json: options.json ?? false,
        print: (line) => void process.stdout.write(`${line}\n`),
      });
    },
  );

program
  .command("watch")
  .description("The status table, redrawn as the collector reports")
  .option(
    "--interval <seconds>",
    "how often to ask the collector (default: 5)",
    "5",
  )
  .option("--plain", "no colour, whatever the terminal")
  .option("--no-notify", "no desktop notification when a node's status changes")
  .option(
    "--notify-on <level>",
    "warn: every change; critical: into or out of critical or stale",
    "warn",
  )
  .action(
    async (options: {
      interval: string;
      plain?: boolean;
      notify: boolean;
      notifyOn: string;
    }) => {
      const { runWatch } = await import("./commands/watch");
      const { desktopNotifier } = await import("./notify/desktop-notifier");
      const { NOTIFY_LEVELS } = await import("./notify/transitions");
      const notifyOn = NOTIFY_LEVELS.find(
        (level) => level === options.notifyOn,
      );

      if (notifyOn === undefined) {
        throw new UsageError(
          `--notify-on must be one of ${NOTIFY_LEVELS.join(", ")}, got "${options.notifyOn}"`,
        );
      }

      await runWatch({
        source: collectorClient(),
        intervalMs: intervalFrom(options.interval) * 1000,
        colour: colourEnabled({
          plain: options.plain ?? false,
          isTerminal: Boolean(process.stdout.isTTY),
          environment: process.env,
        }),
        stdout: process.stdout,
        stdin: process.stdin,
        isTerminal: Boolean(process.stdout.isTTY && process.stdin.isTTY),
        notify: options.notify ? desktopNotifier(process.platform) : undefined,
        notifyOn,
      });
    },
  );

try {
  await program.parseAsync(process.argv);
  process.exitCode = EXIT_OK;
} catch (error) {
  process.exitCode = failed(error);
} finally {
  for (const collector of remoteCollectors) collector.close();
}

/**
 * The collector's client: through an ssh tunnel when `cli.yaml` names a
 * remote, else here. A secret file others can read is said once.
 */
function collectorClient(configPath?: string): ApiClient | RemoteCollector {
  const source = collectorSourceFrom(process.env, configPath);
  const warning =
    source.kind === "remote" ? source.warning : source.config.tokenWarning;
  if (warning !== undefined) process.stderr.write(`warning: ${warning}\n`);

  if (source.kind === "here") return new ApiClient(source.config);

  const collector = new RemoteCollector(source);
  remoteCollectors.push(collector);
  return collector;
}

/** A daemon to ask before probing here: a remote one, or a token here. */
function hasCollector(configPath: string): boolean {
  return (
    (!process.env.EPHOR_API_URL &&
      readCliFile(cliFilePath(configPath)) !== undefined) ||
    findToken({ environment: process.env, configPath }) !== undefined
  );
}

/** `--json` and `--plain` as every command that prints a state takes them. */
function outputFrom(options: { json?: boolean; plain?: boolean }): {
  json: boolean;
  colour: boolean;
  print: (line: string) => void;
} {
  return {
    json: options.json ?? false,
    colour: colourEnabled({
      plain: options.plain ?? false,
      isTerminal: Boolean(process.stdout.isTTY),
      environment: process.env,
    }),
    print: (line) => void process.stdout.write(`${line}\n`),
  };
}

// Whole seconds, 1 to a day: `/api/state` answers in a millisecond, and
// past ~24 days `setTimeout` overflows into firing at once.
function intervalFrom(text: string): number {
  if (!/^[1-9]\d*$/.test(text) || Number(text) > 86_400) {
    throw new UsageError(
      `--interval must be whole seconds, 1 to 86400, got "${text}"`,
    );
  }

  return Number(text);
}

/** A bad `EPHOR_LOG_LEVEL` is the operator's mistake, not a bug. */
function loggerFromEnvironment(): Logger {
  try {
    return createLogger();
  } catch (error) {
    throw new ClientConfigError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Help and version are not failures; a bug deserves its stack. */
function failed(error: unknown): number {
  if (error instanceof CommanderError) {
    return error.exitCode === 0 ? EXIT_OK : EXIT_TOOL_ERROR;
  }

  if (error instanceof UsageError || error instanceof ApiError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    console.error(error);
  }

  return EXIT_TOOL_ERROR;
}
