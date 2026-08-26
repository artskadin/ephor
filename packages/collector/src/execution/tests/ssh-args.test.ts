import { describe, expect, it } from "vitest";
import { buildSshArgs } from "../ssh-args.js";

describe("buildSshArgs", () => {
  it("uses alias and ignores other fields", () => {
    const args = buildSshArgs(
      { alias: "achilles", port: 6666, user: "bruce" },
      "1.2.3.4",
      10,
    );

    expect(args).toContain("achilles");
    expect(args).not.toContain("-p");
    expect(args).not.toContain("pupa@1.2.3.4");
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

  it("omits port when it is the default", () => {
    const args = buildSshArgs({ port: 22, user: "root" }, "1.2.3.4", 10);

    expect(args).not.toContain("-p");
  });

  it("always disables interactive password prompt", () => {
    const args = buildSshArgs({ port: 22 }, "1.2.3.4", 10);
    expect(args).toEqual(expect.arrayContaining(["-o", "BatchMode=yes"]));
  });
});
