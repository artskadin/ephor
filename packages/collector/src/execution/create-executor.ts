import type { Node } from "@ephorate/core";
import { LocalExecutor } from "./local-executor";
import { SshExecutor } from "./ssh-executor";
import type { SshGates } from "./ssh-gates";
import type { CommandExecutor } from "./types";

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
