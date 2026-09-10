import { render } from "ink";
import { UsageError } from "../exit-code";
import { Watch } from "../render/watch";
import { type WatchSource, WatchStore } from "../render/watch-store";

interface WatchOptions {
  source: WatchSource;
  intervalMs: number;
  colour: boolean;
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  /** Both streams: ink's key handling puts stdin into raw mode. */
  isTerminal: boolean;
}

// The alternate screen, as `htop` uses it: nothing lands in the
// scrollback, and the screen from before the command comes back on exit.
// The cursor is hidden here, not per mount: ink shows it on every unmount.
const ENTER_ALTERNATE_SCREEN = "\u001b[?1049h\u001b[H\u001b[?25l";
const LEAVE_ALTERNATE_SCREEN = "\u001b[?25h\u001b[?1049l";
const CLEAR_SCREEN = "\u001b[2J\u001b[H";

/** A drag sends a burst of resizes; one redraw after the last is enough. */
const RESIZE_SETTLE_MS = 100;

const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

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

  const { stdout, stdin } = options;
  const store = new WatchStore({
    source: options.source,
    initial: await options.source.state(),
    intervalMs: options.intervalMs,
    now: Date.now,
  });

  const { promise: quitted, resolve: quit } = Promise.withResolvers<void>();
  let instance: ReturnType<typeof render> | undefined;

  const mount = () => {
    const mounted = render(
      <Watch
        store={store}
        apiUrl={options.source.apiUrl}
        colour={options.colour}
        onQuit={quit}
      />,
      {
        stdout,
        stdin,
        patchConsole: false,
        exitOnCtrlC: false,
        // Ink goes silent under `CI=true`; the terminal check above is ours.
        interactive: true,
      },
    );

    // Ink unmounting on its own (a render error) must not leave a dead
    // screen. An instance we replaced is not that: its exit settles after
    // the new one is already current.
    void mounted.waitUntilExit().then(
      () => {
        if (instance === mounted) quit();
      },
      () => quit(),
    );

    return mounted;
  };

  // On a resize ink erases its previous lines by count, and a line the
  // terminal wrapped meanwhile counts as two: garbage stays. So instead,
  // once the burst settles: unmount, wipe the screen, mount again.
  let settling: NodeJS.Timeout | undefined;
  const redraw = (): void => {
    clearTimeout(settling);
    settling = setTimeout(() => {
      instance?.unmount();
      stdout.write(CLEAR_SCREEN);
      instance = mount();
    }, RESIZE_SETTLE_MS);
  };

  try {
    stdout.write(ENTER_ALTERNATE_SCREEN);
    instance = mount();
    stdout.on("resize", redraw);
    for (const signal of STOP_SIGNALS) process.once(signal, quit);
    store.start();

    await quitted;
  } finally {
    store.stop();
    clearTimeout(settling);
    stdout.off("resize", redraw);
    for (const signal of STOP_SIGNALS) process.off(signal, quit);
    instance?.unmount();
    stdout.write(LEAVE_ALTERNATE_SCREEN);
  }
}
