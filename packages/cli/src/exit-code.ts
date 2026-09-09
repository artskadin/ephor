// Whether the command did its job, not how the fleet is: Warp paints a
// block red on any non-zero exit, and a fleet with one warn was "all red".
export const EXIT_OK = 0;
export const EXIT_TOOL_ERROR = 2;

/** The operator's to fix: printed as its message, no stack, exit 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}
