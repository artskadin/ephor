import type { ApiClient } from "../api-client";
import { stateText } from "../render/state-text";

interface StatusOptions {
  client: ApiClient;
  json: boolean;
  colour: boolean;
  /** Stdout is the data channel; everything for a person goes to stderr. */
  print: (line: string) => void;
}

/** Returning is the whole answer; anything else is thrown and exits 2. */
export async function runStatus(options: StatusOptions): Promise<void> {
  options.print(await stateText(await options.client.state(), options));
}
