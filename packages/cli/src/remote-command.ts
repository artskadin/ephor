import { spawn } from "node:child_process";

interface RemoteCommandOptions {
  /** The ssh alias, or `user@host`, of the machine running `ephor serve`. */
  remote: string;
  /** One line for the remote shell; words in it quoted with `quoteForShell`. */
  command: string;
  /** Written to the command's stdin, then closed. */
  input?: string | undefined;
  /** None: the command ends, or ssh ends a dead link by `ServerAlive`. */
  timeoutMs?: number | undefined;
  /** Each line of stderr as it comes: ssh's own and the command's. */
  onStderrLine?: ((line: string) => void) | undefined;
  /** `ssh`; a test puts its own in place. */
  ssh?: string | undefined;
}

interface RemoteCommandResult {
  /** ssh's exit code: the command's, or 255 when ssh itself failed. */
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs `command` on `remote` over ssh. A failure is a result, never an
 * exception: what it means depends on the command.
 */
export function runOverSsh(
  options: RemoteCommandOptions,
): Promise<RemoteCommandResult> {
  const { remote, command, timeoutMs, onStderrLine } = options;

  return new Promise((resolve) => {
    const child = spawn(
      options.ssh ?? "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "LogLevel=ERROR",
        "-o",
        "ControlPath=none",
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=2",
        "--",
        remote,
        command,
      ],
      {
        stdio: [
          options.input === undefined ? "ignore" : "pipe",
          "pipe",
          "pipe",
        ],
      },
    );
    // ssh gone before reading it all must not take this process along.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input);

    let stdout = "";
    let stderr = "";
    let partialLine = "";
    let timedOut = false;

    // A character split across two chunks stays whole.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (text: string) => {
      stdout += text;
    });
    child.stderr?.on("data", (text: string) => {
      stderr += text;
      if (onStderrLine === undefined) return;

      const lines = (partialLine + text).split("\n");
      partialLine = lines.pop() ?? "";
      for (const line of lines) onStderrLine(line);
    });

    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 255, stdout, stderr: error.message, timedOut });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (partialLine !== "") onStderrLine?.(partialLine);
      resolve({ code: code ?? 255, stdout, stderr, timedOut });
    });
  });
}

/** For ssh's exit 127, the shell's "not found": nvm's PATH is not loaded. */
export function notOnPathMessage(remote: string, said: string): string {
  return (
    `ephor or node is not on ${remote}'s PATH for commands run over ` +
    `ssh (${said}): install ephor there (npm i -g ephorate). With node ` +
    `in a home directory (nvm, a tarball), set its PATH ${BASHRC_FIRST_LINE}`
  );
}

export const BASHRC_FIRST_LINE =
  "on the first line of ~/.bashrc there: Debian's returns early for the " +
  "non-interactive shell ssh runs commands in";

// One word for the remote shell, whatever it holds.
export function quoteForShell(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}
