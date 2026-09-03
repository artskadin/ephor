import type { Ssh } from "@ephor/core";

/**
 * What names the node to ssh: the alias alone, or the pieces the config
 * spelled out. The same list is what `ssh -G` resolves the route from.
 */
export function sshTargetArgs(sshConfig: Ssh, host: string): string[] {
  if (sshConfig.alias) return [sshConfig.alias];

  const args: string[] = [];

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
