import type { StateResponse } from "@ephorate/core";
import { frameOf } from "./frame.js";
import { StatusTable, statusTableWidth } from "./status-table.js";

interface StateTextOptions {
  json: boolean;
  colour: boolean;
}

/** What `status` and `check` print: the answer as JSON, or one table. */
export async function stateText(
  state: StateResponse,
  options: StateTextOptions,
): Promise<string> {
  if (options.json) return JSON.stringify(state, null, 2);

  return frameOf(
    StatusTable({ state, colour: options.colour }),
    statusTableWidth(state),
  );
}
