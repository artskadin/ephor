import type { Ssh } from "@ephor/core";

export function buildSshArgs(
  sshConfig: Ssh,
  host: string,
  connectTimeoutSec: number,
): string[] {
  const args: string[] = [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${connectTimeoutSec}`,
    "-o",
    "LogLevel=ERROR",
  ];

  if (sshConfig.alias) {
    args.push(sshConfig.alias);
  } else {
    if (sshConfig.port !== 22) {
      args.push("-p", String(sshConfig.port));
    }
    if (sshConfig.jump) {
      args.push("-J", sshConfig.jump);
    }
    args.push(sshConfig.user ? `${sshConfig.user}@${host}` : host);
  }

  args.push("bash -s");

  return args;
}
