import { createRegistry } from "@ephorate/collector";
import { ConfigError, loadConfig } from "@ephorate/core";
import { UsageError } from "../exit-code";

interface AccessTargetsOptions {
  configPath: string;
  print: (line: string) => void;
}

/**
 * The nodes `serve` here reaches over ssh, for `setup-access` on another
 * machine: each with its alias, or none for the long form. Run over ssh,
 * never typed.
 */
export async function runAccessTargets(
  options: AccessTargetsOptions,
): Promise<void> {
  const config = await loadConfig(
    options.configPath,
    createRegistry().descriptors(),
  ).catch((error: unknown) => {
    throw error instanceof ConfigError ? new UsageError(error.message) : error;
  });

  const nodes = config.nodes
    .filter((node) => node.enabled && node.ssh !== undefined)
    .map((node) =>
      node.ssh?.alias === undefined
        ? { node: node.name }
        : { node: node.name, alias: node.ssh.alias },
    );

  options.print(JSON.stringify({ nodes }));
}
