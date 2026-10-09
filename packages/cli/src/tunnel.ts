import { type ChildProcess, spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { UsageError } from "./exit-code";

interface TunnelOptions {
  /** The ssh alias, or `user@host`, of the machine `ephor serve` runs on. */
  remote: string;
  /** The API's port there, on its loopback. */
  remotePort: number;
  /** `ssh`; a test puts its own in place. */
  command?: string | undefined;
  /** Up to the first answer: ssh's own `ConnectTimeout` is 10 s of it. */
  timeoutMs?: number | undefined;
}

/** A local port that reaches the remote API until `close`. */
export interface Tunnel {
  url: string;
  isOpen(): boolean;
  close(): void;
}

const READY_POLL_MS = 25;
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * `ssh -L` to the remote's loopback. Not `-N`: measured, ssh then outlives
 * a parent killed by SIGKILL, holding the port. Running `cat` there, ssh
 * ends when our stdin closes, which the kernel does when we die.
 */
export async function openTunnel(options: TunnelOptions): Promise<Tunnel> {
  try {
    return await openOnce(options, await freePort());
  } catch (error) {
    // Another process took the port between our check and ssh's bind.
    if (error instanceof PortTakenError) {
      return openOnce(options, await freePort());
    }
    throw error;
  }
}

class PortTakenError extends Error {}

async function openOnce(
  options: TunnelOptions,
  localPort: number,
): Promise<Tunnel> {
  const { remote, remotePort } = options;
  const child = spawn(
    options.command ?? "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "LogLevel=ERROR",
      // Measured: under a ControlMaster from ~/.ssh/config the forward
      // lives in the master and outlives this ssh. The first -o wins.
      "-o",
      "ControlPath=none",
      // A link dead without a reset (a laptop asleep) ends ssh in ~10 s,
      // so `watch` opens a new tunnel instead of timing out forever.
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=2",
      "-L",
      `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      // `remote: -oProxyCommand=…` in cli.yaml is a host name, no option.
      "--",
      remote,
      "cat > /dev/null",
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  // A dead ssh must not take us with it through an EPIPE on its stdin.
  child.stdin?.on("error", () => undefined);

  let spawnError: Error | undefined;
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", (error) => {
      spawnError = error;
      resolve(null);
    });
  });
  let hasExited = false;
  void exited.then(() => {
    hasExited = true;
  });

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (!(await accepts(localPort))) {
    if (hasExited) {
      if (spawnError !== undefined) {
        throw new UsageError(
          `cannot run ssh to reach ${remote}: ${spawnError.message}`,
        );
      }
      if (stderr.includes("Address already in use")) throw new PortTakenError();
      throw new UsageError(
        `cannot reach ${remote} over ssh: ${lastLine(stderr) ?? `ssh exited with ${await exited}`}`,
      );
    }
    if (Date.now() > deadline) {
      stop(child);
      throw new UsageError(
        `cannot reach ${remote} over ssh: no tunnel within ${(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000} s`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }

  return {
    url: `http://127.0.0.1:${localPort}`,
    isOpen: () => !hasExited,
    close: () => stop(child),
  };
}

function stop(child: ChildProcess): void {
  child.stdin?.end();
  child.kill("SIGTERM");
}

export function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Taken for a moment and given back: ssh binds it next. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port was assigned")),
      );
    });
  });
}

// The last: ssh's verdict comes after a banner or a host-key warning.
export function lastLine(text: string): string | undefined {
  const line = text.trim().split("\n").at(-1);
  return line === undefined || line === "" ? undefined : line;
}
