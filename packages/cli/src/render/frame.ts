import { EventEmitter } from "node:events";
import { render } from "ink";
import type { ReactElement } from "react";

// One frame of an ink element as text, from a stream of our own: no cursor
// movement, whatever stdout is. A live command renders into stdout instead:
// every call here leaves ink's `beforeExit` listener behind.
//
// `columns` is the width the element needs, no more: ink allocates a cell
// per column per line (200 nodes at 10 000 columns: 2.2 s and 869 MB).
export async function frameOf(
  element: ReactElement,
  columns: number,
): Promise<string> {
  let frame = "";

  // Without `rows` ink asks the terminal for its size on every layout,
  // running `tput` when there is none: eight processes per frame.
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows: Number.MAX_SAFE_INTEGER,
    // `unmount()` writes the frame once more and then a bare newline, so
    // a whitespace-only write is skipped. The callback is a flush barrier.
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

  // A component that threw is drawn by ink as an error overview; the exit
  // promise carries the original error, so the command fails instead.
  await instance.waitUntilExit();

  return frame;
}
