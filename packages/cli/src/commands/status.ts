import type { ApiClient } from "../api-client.js";
import { exitCodeFor } from "../exit-code.js";

export interface StatusOptions {
  client: ApiClient;
  json: boolean;
  /**
   * One line of stdout. Stdout is the data channel — `ephor status --json |
   * jq` must see nothing else there — so everything for a person goes to
   * stderr, and the command never writes anywhere but through this.
   */
  print: (line: string) => void;
}

/**
 * `ephor status`: the fleet as the collector sees it. Until the table is
 * written, the answer is JSON with the flag or without; `--json` is already
 * the contract for scripts and stays as it is when the table arrives.
 */
export async function runStatus(options: StatusOptions): Promise<number> {
  const state = await options.client.state();

  options.print(JSON.stringify(state, null, 2));

  return exitCodeFor(state.nodes);
}
