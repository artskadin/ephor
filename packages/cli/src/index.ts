#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command, CommanderError } from "commander";
import { ApiClient, ApiError } from "./api-client.js";
import { ClientConfigError, clientConfigFrom } from "./client-config.js";
import { runStatus } from "./commands/status.js";
import { EXIT_TOOL_ERROR } from "./exit-code.js";

// The one version, read from the package rather than repeated here.
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

/**
 * One binary, both roles: `serve` will be the daemon, everything else is a
 * client of one. Commander parses; each command is a function that returns
 * its exit code, so the contract — 0 ok, 1 node problems, 2 tool error — is
 * decided once per command and enforced here.
 */
const program = new Command("ephor")
  .description("Monitoring for self-hosted VPN nodes")
  .version(version)
  // Commander would exit 1 on a bad option, which the contract reserves for
  // node problems; with the override its refusals come back as errors.
  .exitOverride();

program
  .command("status")
  .description("The state of every node, as the collector sees it")
  .option("--json", "print the collector's answer as JSON")
  .action(async (options: { json?: boolean }) => {
    const client = new ApiClient(clientConfigFrom(process.env));

    process.exitCode = await runStatus({
      client,
      json: options.json ?? false,
      print: (line) => void process.stdout.write(`${line}\n`),
    });
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.exitCode = failed(error);
}

/**
 * What a failure is worth on the way out. Help and version are not
 * failures; Commander has already explained its own refusals; a config or
 * API error is a message for the person; anything else is a bug and
 * deserves its stack.
 */
function failed(error: unknown): number {
  if (error instanceof CommanderError) {
    return error.exitCode === 0 ? 0 : EXIT_TOOL_ERROR;
  }

  if (error instanceof ClientConfigError || error instanceof ApiError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    console.error(error);
  }

  return EXIT_TOOL_ERROR;
}
