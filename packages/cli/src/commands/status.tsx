import type { ApiClient } from "../api-client.js";
import { frameOf } from "../render/frame.js";
import { StatusTable, statusTableWidth } from "../render/status-table.js";

export interface StatusOptions {
  client: ApiClient;
  /** The collector's answer as it came, for scripts. */
  json: boolean;
  /** Tints in the table; see `colourEnabled`. */
  colour: boolean;
  /**
   * One line of stdout. Stdout is the data channel — `ephor status --json |
   * jq` must see nothing else there — so everything for a person goes to
   * stderr, and the command never writes anywhere but through this.
   */
  print: (line: string) => void;
}

/**
 * `ephor status`: the fleet as the collector sees it, a table or JSON.
 * Returning is the whole answer; anything that keeps it from printing is
 * thrown, and the entry point turns that into exit 2.
 */
export async function runStatus(options: StatusOptions): Promise<void> {
  const state = await options.client.state();

  options.print(
    options.json
      ? JSON.stringify(state, null, 2)
      : await frameOf(
          <StatusTable state={state} colour={options.colour} />,
          statusTableWidth(state),
        ),
  );
}
