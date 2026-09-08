/**
 * Part of the contract: the code says whether the command did its job,
 * not how the fleet is. `0`: an answer was printed, whatever the nodes.
 * `2`: the tool itself failed — no daemon, a rejected token, an option it
 * lacks, a component that threw — and no answer was printed.
 *
 * There is no `1` for "a node is not ok". The first contract had one, and
 * Warp, which paints a block red on any non-zero exit, showed what it
 * meant: on a fleet with one `warn` every `status` looked like a failed
 * command while it had answered in full. The fleet's state is data — the
 * table for a person, `--json` for a script — and "something changed" is
 * `watch`'s to notice, not a cron job's to infer from a code that would
 * say the same thing every minute.
 */
export const EXIT_OK = 0;
export const EXIT_TOOL_ERROR = 2;
