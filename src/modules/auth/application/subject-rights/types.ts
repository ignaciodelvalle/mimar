// The two Ley 25.326 rights, and how each one can refuse.
//
// WHY THE FAILURE ARM GREW A `reason` (WU-R, 2026-08-29)
// ---------------------------------------------------------------------------
// It used to be `{ ok: false; error: string }` and nothing else, which is enough
// for exactly one surface: a web form that prints the sentence. The native
// client is a second surface and it does not print sentences — it has to map the
// refusal onto an HTTP status and an `ApiV1ErrorCode`, and "did the limiter
// refuse this, or did the RPC fail" is not recoverable from prose. Answering 503
// to a throttle would tell a phone the platform is broken while it works exactly
// as designed; answering 429 to a broken RPC would tell somebody to wait for a
// thing that will never start working.
//
// The `error` string stays, and stays the es-AR sentence the web already shows.
// The two carry different information on purpose: `reason` is for a machine
// choosing a status, `error` is for a person reading a screen.

/** Why an export or an erasure did not happen. */
export type SubjectRightsFailureReason =
  /** The per-user budget for this right is spent. Retryable, and 429. */
  | "rate_limited"
  /** The RPC (or the guard behind it) refused or broke. 503. */
  | "failed";

/**
 * Why an erasure did not happen.
 *
 * `reason_required` is the erasure's own arm and has no export counterpart: the
 * export takes no input at all, so there is nothing it can refuse as malformed.
 * It is kept OUT of `SubjectRightsFailureReason` rather than folded in so the
 * export's switch cannot grow a dead branch for an input it does not have.
 */
export type EraseSubjectDataFailureReason = SubjectRightsFailureReason | "reason_required";

export type ExportSubjectDataResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; reason: SubjectRightsFailureReason; error: string };

export type EraseSubjectDataResult =
  | { ok: true }
  | { ok: false; reason: EraseSubjectDataFailureReason; error: string };

// NO `surface` PARAMETER, unlike `revokeAllSessions`, and the asymmetry is the
// point rather than an oversight. That use-case takes one because IT writes the
// audit row and the row records which door was used. Both rights here are
// audited by the RPC itself (0059 writes `self_export` / `self_erasure` from
// `auth.uid()`), so a `surface` argument would be a value threaded through two
// call sites and read by nobody — the kind of parameter that later grows a
// meaning nobody decided.
