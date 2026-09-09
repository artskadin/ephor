import type { Ssh } from "@ephorate/core";

// The alias alone, or the pieces the config spelled out; `ssh -G` takes the
// same list.
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
