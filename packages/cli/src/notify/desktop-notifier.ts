import { execFile } from "node:child_process";

export type Notify = (title: string, body: string) => Promise<void>;

/** Runs a program to completion; rejects when it is missing or fails. */
export type RunProgram = (command: string, args: string[]) => Promise<void>;

/** A notification is a courtesy: a stuck helper must not stall `watch`. */
const PROGRAM_TIMEOUT_MS = 5000;

export const runProgram: RunProgram = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: PROGRAM_TIMEOUT_MS }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

/**
 * The platform's own notification centre: `osascript` on macOS (shown as
 * coming from Script Editor; an icon of our own needs a signed app),
 * `notify-send` on Linux. Elsewhere, `undefined`: nothing to show with.
 */
export function desktopNotifier(
  platform: NodeJS.Platform,
  run: RunProgram = runProgram,
): Notify | undefined {
  if (platform === "darwin") {
    return (title, body) =>
      run("osascript", [
        "-e",
        `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`,
      ]);
  }

  if (platform === "linux") {
    return (title, body) => run("notify-send", ["--", title, pangoText(body)]);
  }

  return undefined;
}

// Most notification servers read the body as Pango markup: an `&` or `<`
// from ssh's stderr would garble or drop it.
function pangoText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** The text sits inside an AppleScript literal: `"` and `\` need escaping. */
function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
