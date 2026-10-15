import type { ProbeContext } from "@ephorate/core";
import { describe, expect, it } from "vitest";
import { createRegistry } from "../create-registry";

/** The script a fresh registry's `system` sends to a node. */
async function systemScriptOf(): Promise<string> {
  const scripts: string[] = [];
  const context: ProbeContext = {
    nodeName: "achilles",
    host: "203.0.113.10",
    ports: [],
    startedAt: 1_800_000_000,
    timeoutMs: 1000,
    intervalSeconds: 60,
    settings: {},
    executor: {
      run: async (script) => {
        scripts.push(script);
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    },
  };

  await createRegistry().get("system")?.run(context);
  return scripts.join("\n");
}

describe("createRegistry", () => {
  // A check with no daemon has one run and no earlier reading: its rate
  // comes from two readings within that run.
  it("has system read twice on a node it has no reading of", async () => {
    const script = await systemScriptOf();

    expect(script).toContain("is_fair_base() { return 1; }");
    expect(script).toContain("sleep 5");
  });
});
