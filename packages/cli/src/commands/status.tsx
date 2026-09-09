import type { ApiClient } from "../api-client.js";
import { frameOf } from "../render/frame.js";
import { StatusTable, statusTableWidth } from "../render/status-table.js";

interface StatusOptions {
  client: ApiClient;
  json: boolean;
  colour: boolean;
  /** Stdout is the data channel; everything for a person goes to stderr. */
  print: (line: string) => void;
}

/** Returning is the whole answer; anything else is thrown and exits 2. */
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
