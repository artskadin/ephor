import type { CommandExecutor, CommandResult, RunOptions } from "./types.js";
import { spawnProcess } from "./spawn-process.js";

export class LocalExecutor implements CommandExecutor {
  readonly kind = "local" as const;
  readonly lable = "local";

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
