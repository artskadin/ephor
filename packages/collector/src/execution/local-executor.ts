import { spawnProcess } from "./spawn-process";
import type { CommandExecutor, CommandResult, RunOptions } from "./types";

export class LocalExecutor implements CommandExecutor {
  readonly kind = "local" as const;
  readonly label = "local";

  constructor(private readonly defaultTimeoutMs: number) {}

  async run(script: string, options?: RunOptions): Promise<CommandResult> {
    return spawnProcess(
      "bash",
      ["-s"],
      script,
      options?.timeoutMs ?? this.defaultTimeoutMs,
    );
  }
}
