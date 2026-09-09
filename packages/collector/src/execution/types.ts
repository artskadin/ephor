export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  timeoutMs?: number | undefined;
}

export interface CommandExecutor {
  readonly kind: "local" | "ssh";

  run(script: string, options?: RunOptions): Promise<CommandResult>;
}

export class CommandTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Command timed out after ${timeoutMs}ms`);
    this.name = "CommandTimeoutError";
  }
}
