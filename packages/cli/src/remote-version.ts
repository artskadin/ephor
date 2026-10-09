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
  const there = /^\d+\.\d+\.\d+\S*$/.exec(
    asked.stdout.trim().split("\n").at(-1)?.trim() ?? "",
  )?.[0];
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
  // The address ssh already reached it by, as typed: an alias, user@host
  // or ssh://user@host:port. npm sits beside the node that runs ephor.
  // Not `[` `]` (an IPv6 address): measured, zsh globs them, "no matches".
  const address = /^[\w@.:/-]+$/.test(remote) ? remote : quoteForShell(remote);
  return {
    where: remote,
    command: `ssh ${address} npm i -g ephorate@${here}`,
  };
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
