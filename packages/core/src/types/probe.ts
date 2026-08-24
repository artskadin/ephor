export type ProbeOutcome<T> =
  | { ok: true; data: T; durationMs: number }
  | { ok: false; error: ProbeError; durationMs: number };

export type ProbeError =
  | { kind: "timeout" }
  | { kind: "unreachable"; detail: string }
  | { kind: "auth_failed" }
  | { kind: "bad_response"; status?: number }
  | { kind: "not_configured"; what: string }
  | { kind: "internal"; cause: unknown };
