import type { Ssh } from "@ephorate/core";

// The alias, or the pieces the config spelled out; `ssh -G` takes the same
// list. A key is passed either way: written, it is meant. ssh expands `~`
// in `-i` itself, and says so on stderr when the file is not there.
export function sshTargetArgs(sshConfig: Ssh, host: string): string[] {
  // No agent keys: an agent offering several first runs into the node's
  // MaxAuthTries (6 by default). `IdentityFile` lines in ssh_config still
  // count, and the `-J` hop authenticates on its own, without this key.
  const key = sshConfig.key
    ? ["-i", sshConfig.key, "-o", "IdentitiesOnly=yes"]
    : [];
  if (sshConfig.alias) return [...key, sshConfig.alias];

  const args: string[] = [...key];

  if (sshConfig.port !== 22) {
    args.push("-p", String(sshConfig.port));
  }
  if (sshConfig.jump) {
    args.push("-J", sshConfig.jump);
  }
  args.push(sshConfig.user ? `${sshConfig.user}@${host}` : host);

  return args;
}

export function buildSshArgs(
  sshConfig: Ssh,
  host: string,
  connectTimeoutSec: number,
): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${connectTimeoutSec}`,
    "-o",
    "LogLevel=ERROR",
    ...sshTargetArgs(sshConfig, host),
    "bash -s",
  ];
}
