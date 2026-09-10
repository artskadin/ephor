import { EXIT_OK } from "./exit-code";

/**
 * `ephor status --json | head -c 1`: the reader closes the pipe, the next
 * write fails with EPIPE, and without a handler Node dies on it with a
 * stack and exit 1. The command's own verdict stands when it has one.
 */
export function exitQuietlyOnClosedPipe(stream: NodeJS.WriteStream): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;

    // A pending write to the other stream is lost here; a note for a
    // person, never the answer, which the reader already refused.
    process.exit(
      typeof process.exitCode === "number" ? process.exitCode : EXIT_OK,
    );
  });
}
