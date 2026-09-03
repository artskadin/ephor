import type { Ssh } from "@ephor/core";
import { spawnProcess } from "./spawn-process.js";
import { buildSshArgs, sshTargetArgs } from "./ssh-args.js";
import type { SshGates } from "./ssh-gates.js";
import type { CommandExecutor, CommandResult, RunOptions } from "./types.js";

export interface SshExecutorDeps {
  gates: SshGates;
  /** The process spawner; the real one unless a test says otherwise. */
  spawn?: typeof spawnProcess | undefined;
}

export class SshExecutor implements CommandExecutor {
  readonly kind = "ssh" as const;
  readonly label: string;

  constructor(
    private readonly sshConfig: Ssh,
    private readonly host: string,
    private readonly defaultTimeoutMs: number,
    nodeName: string,
    private readonly deps: SshExecutorDeps,
  ) {
    this.label = `ssh:${nodeName}`;
  }

  async run(script: string, options?: RunOptions): Promise<CommandResult> {
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const connectTimeoutSec = Math.max(5, Math.floor(timeoutMs / 1000 / 3));
    const spawn = this.deps.spawn ?? spawnProcess;

    // The timeout bounds the ssh process, not the wait for a place to run
    // it: a session held back by a crowded sshd still gets its whole
    // timeout once it starts.
    return this.deps.gates.run(sshTargetArgs(this.sshConfig, this.host), () =>
      spawn(
        "ssh",
        buildSshArgs(this.sshConfig, this.host, connectTimeoutSec),
        script,
        timeoutMs,
      ),
    );
  }
}
