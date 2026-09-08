export interface ColourModeInput {
  /** `--plain` on the command line. */
  plain: boolean;
  /** Whether stdout is a terminal: a pipe or a file gets no escape codes. */
  isTerminal: boolean;
  environment: NodeJS.ProcessEnv;
}

/**
 * Colour only where a person will see it and has not asked for none. The
 * `NO_COLOR` convention: present and non-empty disables colour, whatever
 * the value; nothing else in the environment is read, `FORCE_COLOR`
 * included. What colour carries — which node needs attention — must
 * survive without it, which is why `!` is printed either way.
 *
 * This is the client's decision, passed to the table; ink paints through
 * chalk, which has a veto of its own (a `TERM` of `dumb` or none, measured:
 * the tints are dropped, the text and the `!` stay). Neither side is
 * bypassed: chalk knows terminals, this knows the user's wish.
 */
export function colourEnabled(input: ColourModeInput): boolean {
  if (input.plain || !input.isTerminal) return false;

  const noColour = input.environment.NO_COLOR;

  return noColour === undefined || noColour === "";
}
