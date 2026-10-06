import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("./fixtures/fake-ssh.mjs", import.meta.url),
);

/**
 * A directory holding an executable `ssh` that runs the stand-in: first
 * on a child's PATH, it is the `ssh` the tunnel spawns.
 */
export function fakeSshDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ephor-fake-ssh-"));
  const path = join(directory, "ssh");

  writeFileSync(
    path,
    `#!/bin/sh\nexec "${process.execPath}" "${SCRIPT}" "${directory}" "$@"\n`,
  );
  chmodSync(path, 0o755);

  return directory;
}

/** The stand-in's processes from `directory` still running. */
export function fakeSshRunning(directory: string): number {
  try {
    return execFileSync("pgrep", ["-f", `fake-ssh.mjs ${directory}`], {
      encoding: "utf8",
    })
      .trim()
      .split("\n").length;
  } catch {
    // pgrep exits 1 when nothing matches.
    return 0;
  }
}

/** A directory holding an `ephor` that runs the built binary: the remote's. */
export function fakeEphorDirectory(binary: string): string {
  const directory = mkdtempSync(join(tmpdir(), "ephor-fake-remote-"));
  const path = join(directory, "ephor");

  writeFileSync(
    path,
    `#!/bin/sh\nexec "${process.execPath}" "${binary}" "$@"\n`,
  );
  chmodSync(path, 0o755);

  return directory;
}
