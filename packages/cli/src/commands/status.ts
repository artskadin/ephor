import type { ApiClient } from "../api-client";
import { collectorVersionWarning } from "../remote-version";
import { stateText } from "../render/state-text";

interface StatusOptions {
  client: Pick<ApiClient, "state"> & {
    remote?: string | undefined;
    apiUrl?: string | undefined;
  };
  json: boolean;
  colour: boolean;
  /** Stdout is the data channel; everything for a person goes to stderr. */
  print: (line: string) => void;
  note: (line: string) => void;
}

/** Returning is the whole answer; anything else is thrown and exits 2. */
export async function runStatus(options: StatusOptions): Promise<void> {
  const state = await options.client.state();
  const warning = collectorVersionWarning(options.client, state.version);
  if (warning !== undefined) options.note(warning);

  options.print(await stateText(state, options));
}
