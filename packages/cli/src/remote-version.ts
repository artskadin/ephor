import { quoteForShell, runOverSsh } from "./remote-command";
import { VERSION } from "./version";

/**
 * A line when ephor there is another version than this one: it works,
 * and here is how to bring the older one level. Nothing when they match.
 */
export function versionWarning(
  remote: string,
  there: string,
  here = VERSION,
): string | undefined {
  if (there === here) return undefined;
  const { where, command } = levelling(remote, there, here);
  return (
    `warning: ${remote} has ephor ${there}, this computer ephor ${here}. ` +
    `It works, but keep them the same; update it on ${where}:\n  ${command}`
  );
}

// What a collector says goes into a command to copy: a version only.
const VERSION_FORM = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** `undefined` for anything but a plain version: a name, not a command. */
export function versionIn(value: unknown): string | undefined {
  return typeof value === "string" && VERSION_FORM.test(value)
    ? value
    : undefined;
}

/**
 * For a collector's answer: its ephor against this one. On this machine
 * the usual cause is an upgrade while `serve` kept running the old code.
 */
export function collectorVersionWarning(
  collector: { remote?: string | undefined; apiUrl?: string | undefined },
  answered: unknown,
  here = VERSION,
  // The same machine: its own way to restart a serve.
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const there = versionIn(answered);
  if (there === undefined || there === here) return undefined;

  const { remote, apiUrl } = collector;
  if (remote !== undefined) {
    // Installed but not restarted reads the old version: the restart too.
    const warning = versionWarning(remote, there, here);
    return compareVersions(there, here) < 0
      ? `${warning}\n  ssh ${shellWord(remote)} systemctl --user restart ephor     (its service, if it runs as one)`
      : warning;
  }
  if (apiUrl !== undefined && !isLoopback(apiUrl)) {
    return (
      `warning: the collector at ${apiUrl} runs ephor ${there}, this command ` +
      `ephor ${here}. It works, but keep them the same: npm i -g ` +
      "ephorate@<the newer> on the older one, and restart its serve"
    );
  }

  const restart =
    platform === "linux"
      ? "  systemctl --user restart ephor     (or stop it and `ephor serve` again)"
      : "  stop it (Ctrl-C in its tab) and run `ephor serve` again";
  return compareVersions(there, here) < 0
    ? `warning: the ephor serve here runs ephor ${there}, this command ephor ` +
        `${here}: restart it to run this one:\n${restart}`
    : `warning: the ephor serve here runs ephor ${there}, this command ephor ` +
        `${here}, an older install:\n  npm i -g ephorate@${there}`;
}

/**
 * For an ephor there that does not do what this one asks of it: both
 * versions, and the one command that brings the older one level.
 */
export async function olderEphorMessage(
  remote: string,
  ssh?: string | undefined,
  /** Already read from it (`api-access`): no second trip over ssh. */
  known?: string | undefined,
): Promise<string> {
  if (known !== undefined) return incompatibilityText(remote, known);

  const asked = await runOverSsh({
    remote,
    command: "ephor --version",
    timeoutMs: 30_000,
    ssh,
  });
  const there = versionIn(asked.stdout.trim().split("\n").at(-1)?.trim());
  return incompatibilityText(remote, there);
}

export function incompatibilityText(
  remote: string,
  there: string | undefined,
  here = VERSION,
): string {
  if (there === here) {
    return (
      `${remote} has ephor ${there} as this computer does, yet a different ` +
      `build. Install this computer's build on ${remote}, then run this again`
    );
  }
  // A link lost or a timeout reads no version too: no claim which is older.
  const has =
    there === undefined
      ? `The version of ephor on ${remote} could not be read; this computer has ephor ${here}`
      : `${remote} has ephor ${there}, this computer ephor ${here}`;
  const { where, command } = levelling(remote, there ?? "0.0.0", here);
  return `${has}. Update it on ${where}, then run this again:\n  ${command}`;
}

/** The older one is updated, to the newer one's version. */
function levelling(
  remote: string,
  there: string,
  here: string,
): { where: string; command: string } {
  if (compareVersions(there, here) > 0) {
    return {
      where: "this computer",
      command: `npm i -g ephorate@${there}`,
    };
  }
  // npm sits beside the node that runs ephor there.
  return {
    where: remote,
    command: `ssh ${shellWord(remote)} npm i -g ephorate@${here}`,
  };
}

// The address ssh already reached it by, as typed: an alias, user@host or
// ssh://user@host:port. Not `[` `]` (an IPv6 address): measured, zsh globs
// them, "no matches found".
function shellWord(remote: string): string {
  return /^[\w@.:/-]+$/.test(remote) ? remote : quoteForShell(remote);
}

function isLoopback(apiUrl: string): boolean {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(
      new URL(apiUrl).hostname,
    );
  } catch {
    return false;
  }
}

/**
 * By major, minor and patch; on a tie, as semver: no suffix is newer than
 * one (1.0.0 > 1.0.0-rc.1), two suffixes by their numbers (rc.10 > rc.9).
 */
function compareVersions(left: string, right: string): number {
  const parts = (version: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?/.exec(version);
    return {
      numbers: (match?.slice(1, 4) ?? []).map(Number),
      suffix: match?.[4],
    };
  };
  const [a, b] = [parts(left), parts(right)];

  for (let part = 0; part < 3; part += 1) {
    const difference = (a.numbers[part] ?? 0) - (b.numbers[part] ?? 0);
    if (difference !== 0) return difference;
  }
  if (a.suffix === b.suffix) return 0;
  if (a.suffix === undefined) return 1;
  if (b.suffix === undefined) return -1;
  return a.suffix.localeCompare(b.suffix, "en", { numeric: true });
}
