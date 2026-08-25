import { spawn } from "node:child_process";
import { CommandTimeoutError, type CommandResult } from "./types.js";

export async function spawnProcess(
  command: string,
  args: readonly string[],
  scriptForStdin: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const timeoutHandle = setTimeout(() => {
      if (settled) return;

      settled = true;
      child.kill("SIGKILL");
      reject(new CommandTimeoutError(timeoutMs));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (error) => {
      if (settled) return;

      settled = true;
      clearTimeout(timeoutHandle);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;

      settled = true;
      clearTimeout(timeoutHandle);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code ?? -1,
      });
    });

    child.stdin.on("error", () => {});
    child.stdin.write(scriptForStdin);
    child.stdin.end();
  });
}
