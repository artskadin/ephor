import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LISTENING_PORTS_SNIPPET } from "../collect-script";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * The snippet under a real bash, as the script runs it (`set -eu`), with a
 * `ss` of the test's own first on PATH: one that prints what a node's
 * printed, or one that fails. `undefined`: no `ss` at all.
 */
function listeningPortsWith(ss: { prints: string } | "fails" | undefined) {
  const directory = mkdtempSync(join(tmpdir(), "ephor-ss-"));
  directories.push(directory);

  if (ss !== undefined) {
    const body =
      ss === "fails"
        ? "echo 'Cannot open netlink socket' >&2; exit 1"
        : `cat <<'OUTPUT'\n${ss.prints}\nOUTPUT`;
    writeFileSync(join(directory, "ss"), `#!/bin/sh\n${body}\n`);
    chmodSync(join(directory, "ss"), 0o755);
  }

  // Only the test's directory and the system's own: no `ss` sneaks in.
  return execFileSync(
    "bash",
    ["-c", `set -eu\n${LISTENING_PORTS_SNIPPET}\nprintf %s "$listening_ports"`],
    {
      encoding: "utf8",
      env: { PATH: `${directory}:/usr/bin:/bin` },
    },
  );
}

describe("LISTENING_PORTS_SNIPPET", () => {
  // `ss -tlnH` on achilles, 2026-10-04.
  const achilles = [
    "LISTEN 0      128      0.0.0.0:3948 0.0.0.0:*",
    "LISTEN 0      511    127.0.0.1:8443 0.0.0.0:*",
    "LISTEN 0      4096           *:443        *:*",
    "LISTEN 0      4096           *:5201       *:*",
    "LISTEN 0      511            *:2222       *:*",
    "LISTEN 0      128         [::]:3948    [::]:*",
  ].join("\n");

  it("lists every port beyond loopback once, in order, as a JSON string", () => {
    expect(listeningPortsWith({ prints: achilles })).toBe(
      '"443,2222,3948,5201"',
    );
  });

  // The shapes systemd-resolved, a mail daemon and a link-local sshd take.
  it("drops loopback in each of its spellings, and keeps the rest", () => {
    const shapes = [
      "LISTEN 0      4096   127.0.0.53%lo:53    0.0.0.0:*",
      "LISTEN 0      100        [::1]:25         [::]:*",
      "LISTEN 0      100   [::ffff:127.0.0.1]:6000 *:*",
      "LISTEN 0      4096   0.0.0.0%lo:5355    0.0.0.0:*",
      "LISTEN 0      128   [fe80::1]%eth0:22    [::]:*",
    ].join("\n");

    expect(listeningPortsWith({ prints: shapes })).toBe('"22"');
  });

  it("gives an empty list when only loopback listens", () => {
    expect(
      listeningPortsWith({ prints: "LISTEN 0 511 127.0.0.1:8443 0.0.0.0:*" }),
    ).toBe('""');
  });

  // An empty list would read as "nothing listens": a false green.
  it("gives null, and does not stop the script, without a working ss", () => {
    expect(listeningPortsWith(undefined)).toBe("null");
    expect(listeningPortsWith("fails")).toBe("null");
  });
});
