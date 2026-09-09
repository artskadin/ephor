interface ColourModeInput {
  plain: boolean;
  isTerminal: boolean;
  environment: NodeJS.ProcessEnv;
}

// The client's decision, passed to the table; chalk keeps its own veto for
// `TERM=dumb`. `NO_COLOR` present and non-empty disables; nothing else is
// read, `FORCE_COLOR` included.
export function colourEnabled(input: ColourModeInput): boolean {
  if (input.plain || !input.isTerminal) return false;

  const noColour = input.environment.NO_COLOR;

  return noColour === undefined || noColour === "";
}
