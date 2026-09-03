import type { Node } from "@ephor/core";
import { LocalExecutor } from "./local-executor.js";
import { SshExecutor } from "./ssh-executor.js";
import type { SshGates } from "./ssh-gates.js";
import type { CommandExecutor } from "./types.js";

export function createExecutor(
  node: Node,
  defaultTimeoutMs: number,
  gates: SshGates,
): CommandExecutor | undefined {
  if (node.local) {
    return new LocalExecutor(defaultTimeoutMs);
  }

  if (node.ssh) {
    return new SshExecutor(node.ssh, node.host, defaultTimeoutMs, node.name, {
      gates,
    });
  }

  return undefined;
}
