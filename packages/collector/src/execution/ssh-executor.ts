import type { Ssh } from "@ephor/core";
import { buildSshArgs } from "./ssh-args.js";
import { spawnProcess } from "./spawn-process.js";
import type { CommandExecutor, CommandResult, RunOptions } from "./types.js";

export class SshExecutor implements CommandExecutor {
  readonly kind = "ssh" as const;
  readonly label: string;

  constructor(
    private readonly sshConfig: Ssh,
    private readonly host: string,
    private readonly defaultTimeoutMs: number,
    nodeName: string,
  ) {
    this.label = `ssh:${nodeName}`;
  }

  async run(script: string, options?: RunOptions): Promise<CommandResult> {
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const connectTimeoutSec = Math.max(5, Math.floor(timeoutMs / 1000 / 3));

    return spawnProcess(
      "ssh",
      buildSshArgs(this.sshConfig, this.host, connectTimeoutSec),
      script,
      timeoutMs,
    );
  }
}
