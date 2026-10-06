import { describe, expect, it } from "vitest";
import { buildSshArgs } from "../ssh-args";

describe("buildSshArgs", () => {
  it("uses alias and ignores other fields", () => {
    const args = buildSshArgs(
      { alias: "achilles", port: 6666, user: "bruce" },
      "1.2.3.4",
      10,
    );

    expect(args).toContain("achilles");
    expect(args).not.toContain("-p");
    expect(args).not.toContain("bruce@1.2.3.4");
  });

  // In the schema since the start, and silently dropped until 2026-10-05.
  it("passes a key, and no agent keys, with or without an alias", () => {
    for (const ssh of [
      { user: "root", key: "~/.ssh/id_ephor" },
      { alias: "achilles", key: "~/.ssh/id_ephor" },
    ]) {
      const args = buildSshArgs(ssh, "203.0.113.10", 10);
      const at = args.indexOf("-i");

      expect(args.slice(at, at + 4)).toEqual([
        "-i",
        "~/.ssh/id_ephor",
        "-o",
        "IdentitiesOnly=yes",
      ]);
      // Options go before the destination, or ssh takes them as the command.
      expect(at).toBeLessThan(args.indexOf(ssh.alias ?? "root@203.0.113.10"));
    }
  });

  it("leaves the key to ssh's own config when none is written", () => {
    const args = buildSshArgs({ user: "root" }, "203.0.113.10", 10);

    expect(args).not.toContain("-i");
    expect(args).not.toContain("IdentitiesOnly=yes");
  });

  it("builds explicit connection when alias is absent", () => {
    const args = buildSshArgs(
      { port: 6666, user: "pupa", jump: "bastion" },
      "1.2.3.4",
      10,
    );

    expect(args).toEqual(
      expect.arrayContaining(["-p", "6666", "-J", "bastion", "pupa@1.2.3.4"]),
    );
  });

  // Left out, ssh's own: 22, or what ~/.ssh/config says for the host.
  it("passes a port only when one is written, 22 included", () => {
    expect(buildSshArgs({ user: "root" }, "203.0.113.10", 10)).not.toContain(
      "-p",
    );
    expect(
      buildSshArgs({ port: 22, user: "root" }, "203.0.113.10", 10),
    ).toEqual(expect.arrayContaining(["-p", "22"]));
  });

  it("always disables interactive password prompt", () => {
    const args = buildSshArgs({}, "203.0.113.10", 10);
    expect(args).toEqual(expect.arrayContaining(["-o", "BatchMode=yes"]));
  });
});
