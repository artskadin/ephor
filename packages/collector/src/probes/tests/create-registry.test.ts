import type { ProbeContext } from "@ephorate/core";
import { describe, expect, it } from "vitest";
import { createRegistry } from "../create-registry";

/** The script `system` sends to a node, from a registry made with `options`. */
async function systemScriptOf(
  options?: Parameters<typeof createRegistry>[0],
): Promise<string> {
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

  await createRegistry(options).get("system")?.run(context);
  return scripts.join("\n");
}

describe("createRegistry", () => {
  // A daemon never waits on a node; a check with no daemon has one run.
  it("has system read twice per run only for a single run", async () => {
    expect(await systemScriptOf()).not.toContain("sleep");
    expect(await systemScriptOf({ isSingleRun: true })).toContain("sleep 5");
  });
});
