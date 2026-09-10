import { spawnProcess } from "./spawn-process";

/** Which sshd a node's sessions log into: a jump host's, shared, or its own. */
export interface SshRoute {
  /** `jump:<host>:<port>`, `proxy:<command>` or `node:<host>:<port>`. */
  door: string;
  /** The jump host as the config names it, for the `Host <name>` advice. */
  jump?: string | undefined;
}

/** Runs `ssh -G <args>`: the resolved options, no connection. */
export type SshInspector = (args: readonly string[]) => Promise<string>;

export const inspectSshOptions: SshInspector = async (args) => {
  const result = await spawnProcess("ssh", ["-G", ...args], "", 10_000);

  if (result.exitCode !== 0) {
    throw new Error(
      `ssh -G ${args.join(" ")} exited with ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }

  return result.stdout;
};

/** One `key value` per line; defaults are absent, the first occurrence wins. */
export function parseSshOptions(output: string): ReadonlyMap<string, string> {
  const options = new Map<string, string>();

  for (const line of output.split("\n")) {
    const separator = line.indexOf(" ");
    if (separator <= 0) continue;

    const key = line.slice(0, separator).toLowerCase();
    if (!options.has(key)) options.set(key, line.slice(separator + 1).trim());
  }

  return options;
}

export async function resolveSshRoute(
  targetArgs: readonly string[],
  inspect: SshInspector,
): Promise<SshRoute> {
  const options = parseSshOptions(await inspect(targetArgs));
  const host = hostWithPort(options, targetArgs.at(-1) ?? "");
  const proxyJump = options.get("proxyjump");
  const proxyCommand = options.get("proxycommand");

  if (proxyJump !== undefined && proxyJump !== "none") {
    const hop = firstHop(proxyJump);
    const jumpOptions = parseSshOptions(await inspect([hop]));

    // With connection sharing the jump host is logged into once, and the
    // node's own sshd is the door again.
    if (sharesConnection(jumpOptions)) {
      return { door: `node:${host}` };
    }

    return {
      door: `jump:${hostWithPort(jumpOptions, hop)}`,
      jump: hop.replace(/^.*@/, ""),
    };
  }

  // Whether a ProxyCommand shares a connection cannot be told from its
  // text; identical text across nodes says they meet in the same sshd.
  if (proxyCommand !== undefined && proxyCommand !== "none") {
    return { door: `proxy:${proxyCommand}` };
  }

  return { door: `node:${host}` };
}

/** `[user@]host[:port][,next...]`: the first hop, without the port. */
function firstHop(proxyJump: string): string {
  const hop = proxyJump.split(",")[0]?.trim() ?? proxyJump;

  // `[::1]:22` keeps its brackets.
  return hop.startsWith("[") ? hop : hop.replace(/:\d+$/, "");
}

function hostWithPort(
  options: ReadonlyMap<string, string>,
  fallback: string,
): string {
  return `${options.get("hostname") ?? fallback}:${options.get("port") ?? "22"}`;
}

// Both needed: `ControlMaster auto` without a `ControlPath` prints no
// controlpath line, and every session then opens its own connection.
function sharesConnection(options: ReadonlyMap<string, string>): boolean {
  const controlMaster = options.get("controlmaster");
  const controlPath = options.get("controlpath");

  return (
    controlMaster !== undefined &&
    controlMaster !== "false" &&
    controlMaster !== "no" &&
    controlPath !== undefined &&
    controlPath !== "none"
  );
}
