import { describe, expect, it } from "vitest";
import {
  inspectSshOptions,
  parseSshOptions,
  resolveSshRoute,
  type SshInspector,
} from "../ssh-route.js";

/**
 * Excerpts of real `ssh -G` output from a machine whose ~/.ssh/config
 * reaches the nodes through `ProxyJump bastion`, with the addresses moved
 * to the documentation ranges. Options at their default are not printed at
 * all, which is why the direct node has no `proxyjump` line.
 */
const VIA_BASTION = [
  "user bruce",
  "hostname 203.0.113.10",
  "port 2222",
  "controlmaster false",
  "identitiesonly yes",
  "controlpersist no",
  "proxyjump bastion",
  "",
].join("\n");

const BASTION = [
  "hostname 198.51.100.1",
  "port 2222",
  "controlmaster false",
  "controlpersist no",
  "",
].join("\n");

/** The same host with `ControlMaster auto`; `%C` in ControlPath expanded. */
const BASTION_SHARING = [
  "hostname 198.51.100.1",
  "port 2222",
  "controlmaster auto",
  "controlpath /home/bruce/.ssh/cm-c59e853e8d1f262cdce0c82c15bef5d63a92b323",
  "controlpersist no",
  "",
].join("\n");

/** `ControlMaster auto` with no path to share through: ssh prints none. */
const BASTION_MASTER_WITHOUT_PATH = [
  "hostname 198.51.100.1",
  "port 2222",
  "controlmaster auto",
  "controlpersist no",
  "",
].join("\n");

const VIA_PROXY_COMMAND = [
  "hostname 10.0.0.5",
  "controlmaster false",
  "proxycommand ssh -W %h:%p bastion",
  "",
].join("\n");

const DIRECT = [
  "hostname 203.0.113.20",
  "port 22",
  "controlmaster false",
  "",
].join("\n");

/** Answers by the last argument, the way the real thing keys on the host. */
function inspectorOf(outputs: Record<string, string>): SshInspector & {
  calls: string[][];
} {
  const calls: string[][] = [];

  const inspect = async (args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    const output = outputs[args.at(-1) ?? ""];
    if (output === undefined)
      throw new Error(`no fixture for ${args.join(" ")}`);

    return output;
  };

  return Object.assign(inspect, { calls });
}

describe("parseSshOptions", () => {
  it("reads one option per line, keys lowercase, first occurrence winning", () => {
    const options = parseSshOptions("HostName one\nhostname two\nport 22\n");

    expect(options.get("hostname")).toBe("one");
    expect(options.get("port")).toBe("22");
  });

  it("keeps a value that itself contains spaces", () => {
    expect(parseSshOptions(VIA_PROXY_COMMAND).get("proxycommand")).toBe(
      "ssh -W %h:%p bastion",
    );
  });
});

describe("resolveSshRoute", () => {
  it("names the jump host's sshd as the door when nothing shares a connection to it", async () => {
    const inspect = inspectorOf({ achilles: VIA_BASTION, bastion: BASTION });

    await expect(resolveSshRoute(["achilles"], inspect)).resolves.toEqual({
      door: "jump:198.51.100.1:2222",
      jump: "bastion",
    });
    expect(inspect.calls).toEqual([["achilles"], ["bastion"]]);
  });

  // Measured with the real ssh: `ControlMaster auto` without a ControlPath
  // prints no `controlpath` line, and every session then opens its own
  // connection. Taken for sharing, it would let fifty logins loose on the
  // jump host.
  it("does not take ControlMaster without a ControlPath for sharing", async () => {
    const inspect = inspectorOf({
      achilles: VIA_BASTION,
      bastion: BASTION_MASTER_WITHOUT_PATH,
    });

    await expect(resolveSshRoute(["achilles"], inspect)).resolves.toEqual({
      door: "jump:198.51.100.1:2222",
      jump: "bastion",
    });
  });

  // With ControlMaster the jump host logs the collector in once and carries
  // every later session inside that connection; measured, 24 at once with
  // no refusals. Its sshd stops being where sessions meet.
  it("makes the node its own door when the jump host shares a connection", async () => {
    const inspect = inspectorOf({
      achilles: VIA_BASTION,
      bastion: BASTION_SHARING,
    });

    await expect(resolveSshRoute(["achilles"], inspect)).resolves.toEqual({
      door: "node:203.0.113.10:2222",
    });
  });

  it("makes a node reached directly its own door", async () => {
    const inspect = inspectorOf({ "root@203.0.113.20": DIRECT });

    await expect(
      resolveSshRoute(["root@203.0.113.20"], inspect),
    ).resolves.toEqual({ door: "node:203.0.113.20:22" });
    expect(inspect.calls).toHaveLength(1);
  });

  it("keys a ProxyCommand door by the command text, so identical ones meet", async () => {
    const inspect = inspectorOf({ "10.0.0.5": VIA_PROXY_COMMAND });

    await expect(resolveSshRoute(["10.0.0.5"], inspect)).resolves.toEqual({
      door: "proxy:ssh -W %h:%p bastion",
    });
  });

  // `ProxyJump bastion` on one node and `ProxyJump bruce@bastion:2222` on
  // another are one sshd; two doors of eight against it would be sixteen
  // logins at once. The door is the host as ssh resolved it, and the advice
  // names the `Host` entry the user would edit.
  it("asks about the first hop only and keys the door by the resolved host", async () => {
    const inspect = inspectorOf({
      achilles: VIA_BASTION.replace(
        "proxyjump bastion",
        "proxyjump bruce@bastion:2222,other",
      ),
      "bruce@bastion": BASTION,
    });

    await expect(resolveSshRoute(["achilles"], inspect)).resolves.toEqual({
      door: "jump:198.51.100.1:2222",
      jump: "bastion",
    });
    expect(inspect.calls).toEqual([["achilles"], ["bruce@bastion"]]);
  });
});

describe("inspectSshOptions", () => {
  // The real ssh, on a name no config knows: it resolves the defaults and
  // connects nowhere, which is the whole point of `-G`.
  it("hands back what ssh -G prints, without connecting", async () => {
    const options = parseSshOptions(
      await inspectSshOptions(["-p", "2222", "no-such-alias-xyz"]),
    );

    expect(options.get("hostname")).toBe("no-such-alias-xyz");
    expect(options.get("port")).toBe("2222");
    expect(options.get("controlmaster")).toBe("false");
    expect(options.has("proxyjump")).toBe(false);
  });

  it("throws on an argument ssh refuses", async () => {
    await expect(
      inspectSshOptions(["-o", "NoSuchOption=1", "host"]),
    ).rejects.toThrow(/exited with/);
  });
});
