#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command, CommanderError } from "commander";
import { ApiClient, ApiError } from "./api-client.js";
import { ClientConfigError, clientConfigFrom } from "./client-config.js";
import { runStatus } from "./commands/status.js";
import { EXIT_OK, EXIT_TOOL_ERROR } from "./exit-code.js";
import { colourEnabled } from "./render/colour-mode.js";

const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

// One binary, both roles: `serve` will be the daemon, the rest its clients.
// A command that runs to its end has done its job; anything else is thrown.
const program = new Command("ephor")
  .description("Monitoring for self-hosted VPN nodes")
  .version(version)
  // Commander would exit 1 on a bad option; the contract has no 1.
  .exitOverride();

program
  .command("status")
  .description("The state of every node, as the collector sees it")
  .option("--json", "print the collector's answer as JSON")
  .option("--plain", "no colour, whatever the terminal")
  .action(async (options: { json?: boolean; plain?: boolean }) => {
    const client = new ApiClient(clientConfigFrom(process.env));

    await runStatus({
      client,
      json: options.json ?? false,
      colour: colourEnabled({
        plain: options.plain ?? false,
        isTerminal: Boolean(process.stdout.isTTY),
        environment: process.env,
      }),
      print: (line) => void process.stdout.write(`${line}\n`),
    });
  });

try {
  await program.parseAsync(process.argv);
  process.exitCode = EXIT_OK;
} catch (error) {
  process.exitCode = failed(error);
}

/** Help and version are not failures; a bug deserves its stack. */
function failed(error: unknown): number {
  if (error instanceof CommanderError) {
    return error.exitCode === 0 ? EXIT_OK : EXIT_TOOL_ERROR;
  }

  if (error instanceof ClientConfigError || error instanceof ApiError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    console.error(error);
  }

  return EXIT_TOOL_ERROR;
}
