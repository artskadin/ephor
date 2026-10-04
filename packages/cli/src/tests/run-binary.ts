import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The built binary, as `npm i -g ephorate` would install it. Built by
 * `pnpm build`, which is why that runs before the tests.
 */
export const BINARY = fileURLToPath(
  new URL("../../bin/ephor.js", import.meta.url),
);

// Without HOME, Node falls back to the real home directory, where the
// developer's own token file may sit: the default config is an empty one.
const ISOLATED_CONFIG_HOME = mkdtempSync(join(tmpdir(), "ephor-config-"));

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `ephor <words>` as a child process with only the given environment
 * and an empty default config directory: node is started by its own path,
 * and nothing from this shell or this home may leak in.
 * A child that died by a signal or never started reports -1, so it cannot
 * pass for a clean exit.
 */
export function ephor(
  words: string[],
  environment: Record<string, string> = {},
): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BINARY, ...words],
      { env: { XDG_CONFIG_HOME: ISOLATED_CONFIG_HOME, ...environment } },
      (error, stdout, stderr) => {
        let code = 0;

        if (error !== null) {
          code = typeof error.code === "number" ? error.code : -1;
        }

        resolve({ code, stdout, stderr });
      },
    );
  });
}
