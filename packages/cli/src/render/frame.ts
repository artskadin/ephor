import { EventEmitter } from "node:events";
import { render } from "ink";
import type { ReactElement } from "react";

/**
 * One frame of an ink element, as text. Ink is rendered into a stream of
 * our own rather than stdout, so a command that prints once — `status` —
 * writes exactly one frame with no cursor movement, whatever stdout is.
 * The same component serves `check` and `watch`, which render into stdout
 * for as long as they run — not through this, once per tick: every call
 * leaves ink's own `beforeExit` listener on the process, which ink never
 * removes, and Node warns at the eleventh.
 *
 * `columns` is the width ink lays the frame out in, and it should be the
 * width the element needs: ink allocates a cell for every column of every
 * line on each render, so a generous width is paid for in memory and time
 * on a large fleet — see `statusTableWidth`.
 *
 * The element must draw its final frame synchronously: what an effect or a
 * state update changes later is not seen. Measured: ink writes the first
 * frame before `render()` returns, and `unmount()` writes it once more and
 * then a bare newline — which is why the last write is not the frame, and
 * a whitespace-only write is skipped.
 */
export async function frameOf(
  element: ReactElement,
  columns: number,
): Promise<string> {
  let frame = "";

  // What ink needs of a stdout: a size, `write`, and the events of a
  // stream. `rows` is laid out against nothing — a frame is as tall as its
  // content — but a stream missing either dimension makes ink ask the
  // terminal for its size on every layout, and a process without one
  // (cron, a systemd timer) asks by running `tput`: measured, eight
  // processes and 29 ms for a one-word frame, against 9 ms with both set.
  // `debug` makes every render a whole frame rather than a diff.
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows: Number.MAX_SAFE_INTEGER,
    // Node's `write(chunk[, encoding][, callback])`: ink writes an empty
    // chunk with a callback as a flush barrier, and a stream answers it.
    write(chunk: string, encodingOrCallback?: unknown): boolean {
      if (chunk.trim() !== "") frame = chunk;
      if (typeof encodingOrCallback === "function") encodingOrCallback();

      return true;
    },
  });

  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  instance.unmount();

  // A component that threw is caught by ink's own error boundary and drawn
  // as an error overview — into the frame, where it would be printed as
  // data with exit 0, a complete answer that is not one. The exit promise
  // is what carries the original error, so the command fails loudly
  // instead.
  await instance.waitUntilExit();

  return frame;
}
