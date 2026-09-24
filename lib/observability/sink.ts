// Transport seam for client-side error reports (task #56b).
//
// The point of this file is that CHOOSING a telemetry provider must not require
// touching `report-error.ts`, any error boundary, or the redaction rules. A
// provider is wired by calling `setErrorSink()` once at app start with an
// adapter that implements `ErrorSink`. Everything upstream — payload shape,
// allowlist, scrubbing — is provider-agnostic and stays put.
//
// WHAT A SINK IS ALLOWED TO ASSUME
// ---------------------------------------------------------------------------
// A sink receives an ALREADY-REDACTED report. It must not be handed the raw
// Error, and it is not the sink's job to redact: putting redaction behind the
// seam would mean each future provider adapter re-implements it, and the first
// one to get it wrong leaks silently. `reportError` redacts, then dispatches.
//
// WHY THE DEFAULT IS NOT A NO-OP AND NOT A PROMISE
// ---------------------------------------------------------------------------
// The previous version of this module said it would "forward to the chosen
// telemetry sink" and then only called `console.error`. That comment described
// an intention as though it were behavior. The default sink here is named
// `consoleSink`, its `name` is `"console"`, and its docstring says plainly that
// nothing leaves the browser. A reader who wants to know whether production
// errors reach anyone gets a truthful answer from the code.

/**
 * A report that has already passed through the redaction layer.
 *
 * WHY CALLER CONTEXT IS NESTED AND NOT SPREAD
 * ---------------------------------------------------------------------------
 * The payload this replaced was FLAT — `{message, stack, digest, ...context}`
 * — so `source` and `correlationId` sat at the top level next to the error's
 * own fields. Nesting them under `context` is a deliberate choice, and the
 * reason is not tidiness:
 *
 * The two halves are scrubbed by DIFFERENT rules and cannot be. `message`,
 * `stack` and `digest` come from the runtime and are free text, so they go
 * through `redactText`'s denylist — you cannot allowlist what an exception
 * chose to interpolate. Caller context is structured, so it goes through a
 * CLOSED allowlist, and one key (`correlationId`) is even exempted from
 * scrubbing entirely. Two namespaces with two different security properties
 * must not share one flat namespace, because the spread order silently decides
 * which wins: in the old shape `...context` came LAST, so a context key named
 * `message` would have overwritten the denylist-scrubbed error message with an
 * allowlist-scrubbed — or, for an opaque key, an UNSCRUBBED — value, under the
 * exact field name a provider indexes as "the error". `ReportErrorContext` is
 * explicitly designed to be added to ("adding a key here is the review point"),
 * so that collision was one plausible field name away, and it would have been
 * silent.
 *
 * Nesting makes it structurally impossible: no context key can shadow a
 * reporter field, and no reporter field added later can shadow a context key.
 * It also gives a provider adapter exactly one subtree to point at as
 * "caller-supplied", which is what the configuration warning in
 * `docs/architecture/client-error-sink-pending-decision.md` asks for. And it
 * matches `lib/infra/report-error.ts`, the server reporter, which already
 * nests caller data under `meta` — the same split, arrived at independently.
 *
 * The cost was one consumer: `__tests__/analytics-load.test.ts` read
 * `payload.correlationId` through an `as` cast and went red. The cast is gone;
 * it now reads this type, so the next shape change is a compile error.
 */
export type RedactedErrorReport = {
  /** Scrubbed `error.message`. */
  message: string;
  /** Error constructor name, when it is more specific than "Error". */
  name?: string;
  /** Scrubbed and line-capped `error.stack`. */
  stack?: string;
  /** Next.js's hashed error reference. Server-generated, PII-free by construction. */
  digest?: string;
  /** Allowlisted, scrubbed caller context. */
  context: Readonly<Record<string, string | number | boolean>>;
  /** ISO-8601 capture time, added by the reporter (not read from the error). */
  ts: string;
};

/**
 * A telemetry transport. Implementations are adapters around a provider SDK.
 *
 * `send` MUST NOT throw — but `reportError` defends against it anyway, because
 * this code runs inside a React error boundary and a reporter that throws while
 * reporting turns a recoverable error screen into an unrecoverable one.
 */
export type ErrorSink = {
  /** Stable identifier for the transport, e.g. "console" or "sentry". */
  readonly name: string;
  send(report: RedactedErrorReport): void;
};

/**
 * The default sink. Writes one structured line to the browser console and
 * NOTHING ELSE — no network call, no third party, no persistence.
 *
 * Concretely: with this sink installed, an error hitting a tester's phone or a
 * citizen's browser is visible only to someone with that devtools console open.
 * It does not reach the team. That is the current, honest state of client-side
 * observability in this project, and swapping it is a PO decision (see
 * `docs/architecture/client-error-sink-pending-decision.md`).
 */
export const consoleSink: ErrorSink = {
  name: "console",
  send(report: RedactedErrorReport): void {
    console.error("[reportError]", report);
  },
};

let activeSink: ErrorSink = consoleSink;

/**
 * Installs the process-wide sink. Call once during app bootstrap.
 *
 * Returns the sink it replaced so a caller (or a test) can restore it.
 */
export function setErrorSink(sink: ErrorSink): ErrorSink {
  const previous = activeSink;
  activeSink = sink;
  return previous;
}

/** The currently installed sink. */
export function getErrorSink(): ErrorSink {
  return activeSink;
}

/** Restores the default console sink. Primarily for tests. */
export function resetErrorSink(): void {
  activeSink = consoleSink;
}

/**
 * True when errors are going somewhere other than the local console — i.e. when
 * a remote provider has actually been wired.
 *
 * Exposed so a health check or an admin page can state the real posture instead
 * of assuming telemetry exists.
 */
export function hasRemoteErrorSink(): boolean {
  return activeSink !== consoleSink;
}
