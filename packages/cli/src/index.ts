#!/usr/bin/env node
import "./production-mode.js";
import { createRequire } from "node:module";
import { type CheckRequest, createLogger, type Logger } from "@ephorate/core";
import { Command, CommanderError } from "commander";
import { ApiClient, ApiError } from "./api-client.js";
import { ClientConfigError, clientConfigFrom } from "./client-config.js";
import { exitQuietlyOnClosedPipe } from "./closed-pipe.js";
import { runStatus } from "./commands/status.js";
import { resolveConfigPath } from "./config-path.js";
import { EXIT_OK, EXIT_TOOL_ERROR, UsageError } from "./exit-code.js";
import { colourEnabled } from "./render/colour-mode.js";

const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

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
    const { runServe } = await import("./commands/serve.js");

    await runServe({
      configPath: resolveConfigPath({ flag: options.config }),
      databasePath: process.env.EPHOR_DB,
      token: process.env.EPHOR_TOKEN ?? "",
      logger: loggerFromEnvironment(),
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
      const { runCheck } = await import("./commands/check.js");

      const request: CheckRequest = {};
      if (node !== undefined) request.node = node;
      if (options.probe !== undefined) request.probe = options.probe;

      await runCheck({
        configPath: resolveConfigPath({ flag: options.config }),
        request,
        // No token means no daemon was set up: the probes run here.
        client: process.env.EPHOR_TOKEN
          ? new ApiClient(clientConfigFrom(process.env))
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
    const client = new ApiClient(clientConfigFrom(process.env));

    await runStatus({ client, ...outputFrom(options) });
  });

try {
  await program.parseAsync(process.argv);
  process.exitCode = EXIT_OK;
} catch (error) {
  process.exitCode = failed(error);
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
