import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LISTENING_PORTS_SNIPPET,
  NETWORK_READING_SNIPPET,
} from "../collect-script";

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

describe("NETWORK_READING_SNIPPET", () => {
  // achilles, 2026-10-14: counters past 2^31, which mawk's printf "%d" cut.
  const ACHILLES_DEV = [
    "Inter-|   Receive                                                |  Transmit",
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
    "    lo: 182306943  999    0    0    0     0          0         0 182306943  999    0    0    0     0       0          0",
    "  ens3: 167476009583 201878233    0    0    0     0          0         0 151203109560 126919386    0    0    0     0       0          0",
    "  tun0: 5000 50    0    0    0     0          0         0 5000 50    0    0    0     0       0          0",
  ].join("\n");
  const ROUTE_HEADER =
    "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT";
  // achilles's: one default, a docker bridge beside it.
  const ACHILLES_ROUTE = [
    ROUTE_HEADER,
    "ens3\t00000000\t0100000A\t0003\t0\t0\t0\t00000000\t0\t0\t0",
    "docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
  ].join("\n");
  // achilles's IPv6 defaults: the real one, and lo's reject route.
  const IPV6_ROUTE = [
    "00000000000000000000000000000000 00 00000000000000000000000000000000 00 2a01ecc04000049c0000000000000001 00000400 00000002 00000000 00000007     ens3",
    "00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 ffffffff 00000001 00000000 00200200       lo",
  ].join("\n");

  interface ProcFiles {
    netDev?: string;
    route?: string;
    ipv6Route?: string;
    uptime?: string;
    bootId?: string | undefined;
  }

  /**
   * The snippet under a real bash against a /proc of the test's own, called
   * as the script calls it: inside `$(...)` under `set -eu`, then a field
   * after it, which must still print.
   */
  function readingWith(files: ProcFiles = {}) {
    const directory = mkdtempSync(join(tmpdir(), "ephor-net-"));
    directories.push(directory);
    const root = join(directory, "proc");
    mkdirSync(join(root, "net"), { recursive: true });
    mkdirSync(join(root, "sys/kernel/random"), { recursive: true });
    writeFileSync(join(root, "net/dev"), `${files.netDev ?? ACHILLES_DEV}\n`);
    writeFileSync(
      join(root, "net/route"),
      `${files.route ?? ACHILLES_ROUTE}\n`,
    );
    writeFileSync(
      join(root, "net/ipv6_route"),
      `${files.ipv6Route ?? IPV6_ROUTE}\n`,
    );
    writeFileSync(
      join(root, "uptime"),
      files.uptime ?? "2510264.54 4900000.10\n",
    );
    if (!("bootId" in files) || files.bootId !== undefined) {
      writeFileSync(
        join(root, "sys/kernel/random/boot_id"),
        files.bootId ?? "5f0c3c1e-8a7b-4c4f-9d2e-1a2b3c4d5e6f\n",
      );
    }

    const output = execFileSync(
      "bash",
      [
        "-c",
        `set -eu\n${NETWORK_READING_SNIPPET}\nnetwork=$(network_reading ${root})\nprintf '%s|after' "$network"`,
      ],
      { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
    );
    const [reading, after] = output.split("|");
    expect(after).toBe("after");
    return reading === "null" ? null : JSON.parse(reading ?? "");
  }

  it("reads the default route's counters in full, with the node's clock", () => {
    expect(readingWith()).toEqual({
      interface: "ens3",
      bootId: "5f0c3c1e-8a7b-4c4f-9d2e-1a2b3c4d5e6f",
      uptimeSeconds: 2510264.54,
      receivedBytes: 167476009583,
      sentBytes: 151203109560,
    });
  });

  // OpenVPN's two halves cover everything, yet neither is the default.
  it("takes the true default of lowest metric, not a 0.0.0.0/1 before it", () => {
    const route = [
      ROUTE_HEADER,
      "tun0\t00000000\t0100080A\t0003\t0\t0\t0\t00000080\t0\t0\t0",
      "tun0\t00000000\t0100080A\t0003\t0\t0\t200\t00000000\t0\t0\t0",
      "ens3\t00000000\t0100000A\t0003\t0\t0\t100\t00000000\t0\t0\t0",
    ].join("\n");

    expect(readingWith({ route })).toMatchObject({ interface: "ens3" });
  });

  it("falls back to the IPv6 default, past lo's reject route", () => {
    expect(readingWith({ route: ROUTE_HEADER })).toMatchObject({
      interface: "ens3",
      receivedBytes: 167476009583,
    });
  });

  // 000003e8 read as a number is 3e8: the higher metric would win.
  it("takes the IPv6 default of lowest metric, comparing its hex as text", () => {
    const ipv6Route = [
      "00000000000000000000000000000000 00 00000000000000000000000000000000 00 2a01ecc04000049c0000000000000001 00000400 00000002 00000000 00000003     tun0",
      "00000000000000000000000000000000 00 00000000000000000000000000000000 00 2a01ecc04000049c0000000000000001 000003e8 00000002 00000000 00000003     ens3",
    ].join("\n");

    expect(readingWith({ route: ROUTE_HEADER, ipv6Route })).toMatchObject({
      interface: "ens3",
    });
  });

  // Older kernels print a wide counter right after the colon.
  it("reads a counter with no space after the interface's colon", () => {
    const glued = ACHILLES_DEV.replace(
      "ens3: 167476009583",
      "ens3:167476009583",
    );

    expect(readingWith({ netDev: glued })).toMatchObject({
      receivedBytes: 167476009583,
    });
  });

  // Each would have stopped the whole script, or broken its JSON.
  it.each<[string, ProcFiles]>([
    ["no default route", { route: ROUTE_HEADER, ipv6Route: "" }],
    [
      "an interface not in net/dev",
      { netDev: ACHILLES_DEV.split("\n").slice(0, 3).join("\n") },
    ],
    ["no boot id", { bootId: undefined }],
    ["an empty uptime", { uptime: "" }],
    ["a boot id with a quote", { bootId: 'a"b\n' }],
  ])("gives null, and the script goes on, with %s", (_, files) => {
    expect(readingWith(files)).toBeNull();
  });
});
