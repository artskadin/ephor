import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authorizeScript,
  destinationIn,
  hostKeysIn,
  installScript,
  KEY_SCRIPT,
  NO_HOST_KEY_EXIT,
  type NodeAccess,
  publicKeyIn,
  verifiedIn,
} from "../access-scripts";

/**
 * The scripts run as they would there, by the real `sh`, in a home of
 * their own: nothing touches this machine's ~/.ssh.
 */
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true });
});

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "ephor-home-"));
  homes.push(path);
  return path;
}

function run(script: string, environment: Record<string, string>) {
  return spawnSync("sh", ["-c", script], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", ...environment },
  });
}

const KEY = { type: "ssh-ed25519", body: "AAAAC3NzaC1lZDI1NTE5AAAAIExample" };

const access: NodeAccess = {
  alias: "achilles",
  destination: { hostname: "203.0.113.10", port: 3948, user: "bruce" },
  hostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHost"],
};

const HOST_BLOCK = [
  "# Written by `ephor setup-access`; rewritten on each run.",
  "Host achilles",
  "  HostName 203.0.113.10",
  "  Port 3948",
  "  User bruce",
  "  IdentityFile ~/.ssh/ephor/id_ed25519",
  "  IdentitiesOnly yes",
  "  UserKnownHostsFile ~/.ssh/ephor/achilles.known_hosts",
  "",
].join("\n");

describe("the collector's key", () => {
  it("is made once, private to its owner, and its public half printed", () => {
    const HOME = home();

    const first = run(KEY_SCRIPT, { HOME });
    const second = run(KEY_SCRIPT, { HOME });

    expect(first.status).toBe(0);
    const key = publicKeyIn(first.stdout);
    expect(key?.type).toBe("ssh-ed25519");
    expect(publicKeyIn(second.stdout)).toEqual(key);
    expect(statSync(join(HOME, ".ssh")).mode & 0o777).toBe(0o700);
    expect(statSync(join(HOME, ".ssh/ephor/id_ed25519")).mode & 0o777).toBe(
      0o600,
    );
  });

  it("is read past a login banner", () => {
    expect(
      publicKeyIn(`Welcome!\nssh-ed25519 ${KEY.body} ephor@bastion\n`),
    ).toEqual(KEY);
  });
});

describe("letting the collector in on a node", () => {
  function node(): { HOME: string; hostKeys: string } {
    const HOME = home();
    const hostKeys = join(HOME, "etc");
    mkdirSync(hostKeys);
    writeFileSync(
      join(hostKeys, "ssh_host_ed25519_key.pub"),
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHost root@node\n",
    );
    return { HOME, hostKeys: join(hostKeys, "ssh_host_*_key.pub") };
  }

  it("adds the key once, with its options, and prints the host keys", () => {
    const { HOME, hostKeys } = node();
    const script = authorizeScript(KEY, "ephor@bastion", hostKeys);

    const first = run(script, { HOME });
    run(script, { HOME });

    expect(first.status).toBe(0);
    const file = join(HOME, ".ssh/authorized_keys");
    expect(readFileSync(file, "utf8")).toBe(
      `no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 ${KEY.body} ephor@bastion\n`,
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(hostKeysIn(first.stdout)).toEqual([
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHost",
    ]);
  });

  it("adds it again when the copy there is commented out", () => {
    const { HOME, hostKeys } = node();
    mkdirSync(join(HOME, ".ssh"), { mode: 0o700 });
    writeFileSync(
      join(HOME, ".ssh/authorized_keys"),
      `# ssh-ed25519 ${KEY.body} ephor@bastion\n`,
    );

    run(authorizeScript(KEY, "ephor@bastion", hostKeys), { HOME });

    expect(
      readFileSync(join(HOME, ".ssh/authorized_keys"), "utf8").split("\n"),
    ).toHaveLength(3);
  });

  it("lets nothing in without a host key to trust the node by", () => {
    const HOME = home();

    const result = run(
      authorizeScript(KEY, "ephor@bastion", join(HOME, "none/*.pub")),
      { HOME },
    );

    expect(result.status).toBe(NO_HOST_KEY_EXIT);
    expect(existsSync(join(HOME, ".ssh/authorized_keys"))).toBe(false);
  });

  it("keeps the keys there, a last one without its newline included", () => {
    const { HOME, hostKeys } = node();
    mkdirSync(join(HOME, ".ssh"), { mode: 0o700 });
    writeFileSync(join(HOME, ".ssh/authorized_keys"), "ssh-ed25519 AAAAmine");

    run(authorizeScript(KEY, "ephor@bastion", hostKeys), { HOME });

    const lines = readFileSync(join(HOME, ".ssh/authorized_keys"), "utf8")
      .trimEnd()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("ssh-ed25519 AAAAmine");
    expect(lines[1]).toContain(KEY.body);
  });
});

describe("the collector's ssh files", () => {
  /** `ssh` that answers as the test says: no test runs a real login. */
  function stubSsh(succeeds: boolean): string {
    const directory = home();
    writeFileSync(
      join(directory, "ssh"),
      succeeds
        ? "#!/bin/sh\nexit 0\n"
        : '#!/bin/sh\necho "ssh: connect to host 203.0.113.10 port 3948: Operation timed out" >&2\nexit 255\n',
    );
    chmodSync(join(directory, "ssh"), 0o755);
    return directory;
  }

  function installed(HOME: string, succeeds = true) {
    mkdirSync(join(HOME, ".ssh/ephor"), { recursive: true, mode: 0o700 });
    return run(installScript([access]), {
      HOME,
      PATH: `${stubSsh(succeeds)}:/usr/bin:/bin`,
    });
  }

  it("puts the node's Host block and host keys in place once it logs in", () => {
    const HOME = home();

    const result = installed(HOME);

    expect(result.status).toBe(0);
    expect(readFileSync(join(HOME, ".ssh/ephor/achilles.conf"), "utf8")).toBe(
      HOST_BLOCK,
    );
    expect(
      readFileSync(join(HOME, ".ssh/ephor/achilles.known_hosts"), "utf8"),
    ).toBe("[203.0.113.10]:3948 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHost\n");
    expect(verifiedIn(result.stdout)).toEqual([
      { alias: "achilles", code: 0, said: "" },
    ]);
  });

  // In the first Include, a block that does not work would hide one that did.
  it("keeps what a node had when the login with the new files fails", () => {
    const HOME = home();
    mkdirSync(join(HOME, ".ssh/ephor"), { recursive: true });
    writeFileSync(join(HOME, ".ssh/ephor/achilles.conf"), "Host achilles\n");

    const result = installed(HOME, false);

    expect(verifiedIn(result.stdout)).toEqual([
      {
        alias: "achilles",
        code: 255,
        said: "ssh: connect to host 203.0.113.10 port 3948: Operation timed out",
      },
    ]);
    expect(readFileSync(join(HOME, ".ssh/ephor/achilles.conf"), "utf8")).toBe(
      "Host achilles\n",
    );
    expect(existsSync(join(HOME, ".ssh/ephor/achilles.conf.new"))).toBe(false);
  });

  // After a `Host` line, an Include would hold only inside that block.
  it("puts the Include first in ~/.ssh/config, once, keeping the rest", () => {
    const HOME = home();
    mkdirSync(join(HOME, ".ssh"), { mode: 0o700 });
    writeFileSync(join(HOME, ".ssh/config"), "Host mine\n  User me\n");

    installed(HOME);
    installed(HOME);

    expect(readFileSync(join(HOME, ".ssh/config"), "utf8")).toBe(
      "Include ephor/*.conf\nHost mine\n  User me\n",
    );
  });

  it("writes through a symlinked ~/.ssh/config, leaving the link", () => {
    const HOME = home();
    mkdirSync(join(HOME, ".ssh"), { mode: 0o700 });
    writeFileSync(join(HOME, "dotfiles-ssh"), "Host mine\n");
    symlinkSync(join(HOME, "dotfiles-ssh"), join(HOME, ".ssh/config"));

    installed(HOME);

    expect(lstatSync(join(HOME, ".ssh/config")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(HOME, "dotfiles-ssh"), "utf8")).toBe(
      "Include ephor/*.conf\nHost mine\n",
    );
  });

  it("stops before anything when ~/.ssh/config cannot be read", () => {
    const HOME = home();
    mkdirSync(join(HOME, ".ssh"), { mode: 0o700 });
    writeFileSync(join(HOME, ".ssh/config"), "Host mine\n", { mode: 0o000 });

    const result = installed(HOME);
    chmodSync(join(HOME, ".ssh/config"), 0o600);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot read");
    expect(readFileSync(join(HOME, ".ssh/config"), "utf8")).toBe("Host mine\n");
    expect(existsSync(join(HOME, ".ssh/ephor/achilles.conf"))).toBe(false);
  });

  it("writes known hosts as ssh looks them up, bare on port 22", () => {
    const HOME = home();
    mkdirSync(join(HOME, ".ssh/ephor"), { recursive: true });
    const onPort22 = { ...access.destination, port: 22 };

    run(installScript([{ ...access, destination: onPort22 }]), {
      HOME,
      PATH: `${stubSsh(true)}:/usr/bin:/bin`,
    });

    expect(
      readFileSync(join(HOME, ".ssh/ephor/achilles.known_hosts"), "utf8"),
    ).toBe("203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHost\n");
  });

  // Checked by the real ssh: it reads the block through the Include.
  it("is what ssh resolves the alias to", () => {
    const HOME = home();
    installed(HOME);

    const resolved = execFileSync(
      "ssh",
      ["-G", "-F", join(HOME, ".ssh/config"), "achilles"],
      { encoding: "utf8", env: { HOME, PATH: "/usr/bin:/bin" } },
    );

    expect(destinationIn(resolved)).toEqual(access.destination);
    expect(resolved).toContain("identityfile ~/.ssh/ephor/id_ed25519\n");
    expect(resolved).toMatch(/^userknownhostsfile .*\/achilles\.known_hosts$/m);
  });
});

describe("reading ssh -G", () => {
  it("takes the address the real ssh would use", () => {
    const resolved = execFileSync(
      "ssh",
      ["-G", "-F", "/dev/null", "-p", "2222", "-l", "bruce", "203.0.113.10"],
      { encoding: "utf8" },
    );

    expect(destinationIn(resolved)).toEqual({
      hostname: "203.0.113.10",
      port: 2222,
      user: "bruce",
    });
  });
});
