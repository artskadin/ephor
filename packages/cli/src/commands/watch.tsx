import { render } from "ink";
import { UsageError } from "../exit-code";
import { Watch, type WatchSource } from "../render/watch";

interface WatchOptions {
  source: WatchSource;
  intervalMs: number;
  colour: boolean;
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  /** Both streams: ink's key handling puts stdin into raw mode. */
  isTerminal: boolean;
}

/**
 * Live until `q` or Ctrl-C, then exit 0. The first fetch happens before
 * ink takes the screen: a bad address fails like `status` does, exit 2.
 */
export async function runWatch(options: WatchOptions): Promise<void> {
  if (!options.isTerminal) {
    throw new UsageError(
      "watch redraws in a terminal, reading keys from it; for a pipe or a " +
        "file use `ephor status`",
    );
  }

  const initial = await options.source.state();

  const instance = render(
    <Watch
      source={options.source}
      initial={initial}
      intervalMs={options.intervalMs}
      colour={options.colour}
      now={Date.now}
    />,
    { stdout: options.stdout, stdin: options.stdin, patchConsole: false },
  );

  await instance.waitUntilExit();
}
