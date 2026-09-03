import { spawnProcess } from "./spawn-process.js";

/**
 * Which sshd a node's ssh sessions log into, as far as sharing goes.
 *
 * Every session logs into some sshd, and an sshd holds at most about ten
 * logins in progress at once (`MaxStartups 10:30:100`): measured on a
 * bastion, refusals begin at twelve concurrent connections. A node reached
 * through a jump host logs into that host's sshd first, together with every
 * other node behind it; a node reached directly logs into its own, which no
 * other node touches. `door` names the sshd so sessions through the same one
 * can be counted together.
 */
export interface SshRoute {
  /**
   * `jump:<host>:<port>`, `proxy:<command>` or `node:<host>:<port>` — the
   * host as ssh resolved it, so `ProxyJump bastion` and
   * `ProxyJump bruce@bastion` meet in one door rather than two.
   */
  door: string;
  /**
   * The jump host as the config names it, when its sshd is the door: what
   * the advice to add `ControlMaster` under `Host <name>` has to say.
   */
  jump?: string | undefined;
}

/** Runs `ssh -G <args>` and hands back what it printed: the resolved options. */
export type SshInspector = (args: readonly string[]) => Promise<string>;

/**
 * The real thing. `ssh -G` reads the config files and prints every option
 * as ssh would use it, without connecting anywhere; measured at 7 ms.
 */
export const inspectSshOptions: SshInspector = async (args) => {
  const result = await spawnProcess("ssh", ["-G", ...args], "", 10_000);

  if (result.exitCode !== 0) {
    throw new Error(
      `ssh -G ${args.join(" ")} exited with ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }

  return result.stdout;
};

/**
 * One `key value` per line, keys lowercase, options left at their default
 * simply absent — `proxyjump` is not printed as `none`, it is not printed
 * at all. The first occurrence of a key wins, as it does in ssh itself.
 */
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
  const host = hostOf(options, targetArgs.at(-1) ?? "");
  const proxyJump = options.get("proxyjump");
  const proxyCommand = options.get("proxycommand");

  if (proxyJump !== undefined && proxyJump !== "none") {
    const hop = firstHop(proxyJump);
    const jumpOptions = parseSshOptions(await inspect([hop]));

    // With connection sharing the jump host logs the collector in once and
    // carries every later session over that one connection, so its sshd
    // stops being the place where sessions meet: measured, 24 at once with
    // no refusals. The node's own sshd is then the door again.
    if (sharesConnection(jumpOptions)) {
      return { door: `node:${host}` };
    }

    return {
      door: `jump:${hostOf(jumpOptions, hop)}`,
      jump: hop.replace(/^.*@/, ""),
    };
  }

  // The older spelling of a jump, `ssh -W %h:%p bastion`. Whether the
  // command shares a connection cannot be told from its text, so it is
  // taken as not sharing; the identical text across nodes is what says
  // they meet in the same sshd.
  if (proxyCommand !== undefined && proxyCommand !== "none") {
    return { door: `proxy:${proxyCommand}` };
  }

  return { door: `node:${host}` };
}

/** `[user@]host[:port][,next...]` — the first hop, without the port. */
function firstHop(proxyJump: string): string {
  const hop = proxyJump.split(",")[0]?.trim() ?? proxyJump;

  // `[::1]:22` keeps its brackets; `user@host:22` loses the port.
  return hop.startsWith("[") ? hop : hop.replace(/:\d+$/, "");
}

/** The host as ssh resolved it, with its port: the identity of one sshd. */
function hostOf(
  options: ReadonlyMap<string, string>,
  fallback: string,
): string {
  return `${options.get("hostname") ?? fallback}:${options.get("port") ?? "22"}`;
}

/**
 * Sharing takes both: `ControlMaster` on and a `ControlPath` to share
 * through. Measured with the real ssh: `ControlMaster auto` without a path
 * prints no `controlpath` line at all, and every session then opens its
 * own connection — which, taken for sharing, would let fifty logins loose
 * on the jump host's sshd.
 */
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
