// Single entry point for reporting errors caught at a CLIENT error boundary
// (app/error.tsx → components/ErrorBoundary.tsx, app/global-error.tsx). Every
// boundary calls this instead of `console.error` directly, so wiring a real
// telemetry sink is a one-call change (`setErrorSink`) instead of a
// search-and-replace across every boundary.
//
// WHERE ERRORS ACTUALLY GO TODAY — read this before assuming coverage
// ---------------------------------------------------------------------------
// SERVER errors are reported by `lib/infra/report-error.ts`, which writes one
// structured JSON line to stdout; Vercel captures that into queryable function
// logs. That path works and needs no provider.
//
// CLIENT errors — this module — currently reach the browser console and stop
// there. With the default `consoleSink`, an exception on a tester's phone is
// visible to nobody unless that tester says "se cerró sola". The seam, the
// redaction and the payload contract below are all real; the remote transport
// is the one piece that is deliberately absent, because picking a provider has
// billing and data-processing-agreement consequences that are the PO's call,
// not an agent's. The costed comparison is in
// `docs/architecture/client-error-sink-pending-decision.md`.
//
// The module does not claim otherwise anywhere. `hasRemoteErrorSink()` answers
// the question honestly at runtime.
//
// Scope: this is the APP-WIDE client seam (route error.tsx + shared
// ErrorBoundary + lib/analytics). It does not cover panorama's inline WebGL
// recovery (components/panorama/MapErrorBoundary.tsx) — that boundary is owned
// by a different lane and keeps its own console.error for now.

import { redactContextValue, redactText } from "@/lib/observability/redact";
import { type RedactedErrorReport, getErrorSink } from "@/lib/observability/sink";

/**
 * Max stack lines kept (message line + frames).
 *
 * Mirrors `lib/infra/report-error.ts` deliberately: the first frames carry the
 * signal, and a bounded stack is a bounded amount of text that can contain
 * something it should not.
 */
const MAX_STACK_LINES = 7;

/**
 * CLOSED allowlist of context keys.
 *
 * This used to be `[key: string]: unknown`, which meant any call site could
 * attach anything — a whole profile row, a form's values, a fetch Response —
 * and it would ride straight into the report. Closing the set makes an
 * unreviewed field a COMPILE error at the call site, in the same spirit as the
 * `SuppressedCells` branded type that makes an unsuppressed public aggregate
 * uncompilable (AGENTS.md § Privacidad, rule 6).
 *
 * Adding a key here is the review point: it means someone decided that field is
 * safe to send to a third party. Do not widen it back to an index signature.
 */
export type ReportErrorContext = {
  /** Route segment or boundary name, e.g. "/gob/panorama" or "ErrorBoundary". */
  route?: string;
  /** Static "back to safety" href rendered by the boundary. */
  homeHref?: string;
  /** Function or module that caught the error, e.g. "loadWithTimeout". */
  source?: string;
  /** Short synthetic id shown to the user so support can correlate. */
  correlationId?: string;
  /** Named boundary component, when several share a route. */
  boundary?: string;
};

const ALLOWED_CONTEXT_KEYS = [
  "route",
  "homeHref",
  "source",
  "correlationId",
  "boundary",
] as const satisfies ReadonlyArray<keyof ReportErrorContext>;

/**
 * Keys whose values this application GENERATES and therefore knows are free of
 * PII by construction. They skip the text scrubber.
 *
 * `correlationId` is 8 hex characters (`lib/analytics/analytics-load.ts`
 * `newCorrelationId`, the first 8 hex of a UUID).
 *
 * HOW OFTEN THE SCRUBBER WOULD EAT ONE — recounted 2026-08-29, and the old
 * number here was wrong by 2.2x for a reason worth keeping. It said "2.3% are
 * all-digits ... one time in forty-three", which is the right arithmetic for
 * the wrong event: `(10/16)^8 = 2.33%` is the chance that all eight characters
 * are digits. But the rule is `\d{7,}`, a run of SEVEN or more, so it also
 * destroys the two families where a single non-digit sits at one end
 * (`a0318775`, `4031877a`). Exhaustively over all 256 digit/non-digit masks:
 * `(10/16)^8 + 2·(10/16)^7·(6/16)` = **5.12%, about one in twenty**. Counting
 * the all-digits case only was a reasoning error, not a slip in the sum.
 *
 * So the bypass is not a nicety at 1-in-43; at 1-in-20 it is the difference
 * between a support workflow that works and one that silently fails for every
 * twentieth caller.
 *
 * WHICH KEY may bypass is decided by KEY, never by inspecting the value's
 * shape — a scrubber you can talk your way out of by looking like something
 * safe is not a scrubber. The bound below is a separate question from that
 * one: given a key that IS eligible, how much damage can a call site do
 * through it?
 */
const OPAQUE_CONTEXT_KEYS: ReadonlySet<string> = new Set(["correlationId"]);

/**
 * The bound on the opaque bypass.
 *
 * The bypass exists for identifiers this app mints, and everything it mints is
 * a short, unpunctuated token. A value that is not one of those did not come
 * from `newCorrelationId`, so the reason for exempting it does not apply.
 * Without this bound the type is the only thing standing between a call site
 * and an unscrubbed free-text field: `correlationId` is declared `string`, and
 * a caller who put `` `${email} at ${href}` `` there — by mistake, or because
 * the field looked like a convenient place to hang a note — would have shipped
 * it verbatim to a third party. The type system is not present at the moment
 * the payload is sent, which is the whole reason `redactContext` re-checks the
 * allowlist at runtime; the bypass inside it needs the same treatment.
 *
 * A value that fails the bound is NOT dropped — it falls through to the normal
 * scrubber, which is the safe path, not the lossy one.
 */
const OPAQUE_VALUE_SHAPE = /^[A-Za-z0-9_-]{1,32}$/;

export type { RedactedErrorReport } from "@/lib/observability/sink";

function trimStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const lines = stack.split("\n");
  return lines.length <= MAX_STACK_LINES ? stack : lines.slice(0, MAX_STACK_LINES).join("\n");
}

/**
 * Projects caller context down to the allowlisted keys and scrubs what survives.
 *
 * Runtime enforcement, not just types: the parameter is typed, but a JavaScript
 * caller, an `as never`, or a `JSON.parse` result can still arrive with extra
 * keys, and the type system is not present at the moment the payload is sent.
 */
function redactContext(
  context: ReportErrorContext | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!context) return out;

  for (const key of ALLOWED_CONTEXT_KEYS) {
    const raw = (context as Record<string, unknown>)[key];
    if (raw === undefined || raw === null) continue;

    // The bypass is eligible by KEY, and then bounded by what the app actually
    // mints. Anything outside the bound takes the ordinary scrubbed path.
    const bypasses =
      OPAQUE_CONTEXT_KEYS.has(key) && typeof raw === "string" && OPAQUE_VALUE_SHAPE.test(raw);

    const value = bypasses ? raw : redactContextValue(raw);

    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Builds the redacted report for an error. Exported for tests and for any
 * future sink adapter that needs the exact shape without dispatching.
 */
export function buildErrorReport(
  error: Error & { digest?: string },
  context?: ReportErrorContext,
): RedactedErrorReport {
  const stack = trimStack(error.stack);
  return {
    message: redactText(error.message),
    ...(error.name && error.name !== "Error" ? { name: error.name } : {}),
    ...(stack ? { stack: redactText(stack) } : {}),
    // Next.js digests are a server-side hash of the error — no PII by
    // construction, and the user reads this exact string to support.
    ...(error.digest ? { digest: error.digest } : {}),
    context: redactContext(context),
    ts: new Date().toISOString(),
  };
}

/**
 * Reports a client-side error: redacts it, then hands it to the installed sink.
 *
 * Never throws. This runs inside a React error boundary, so a reporter that
 * threw while reporting would replace a recoverable error screen with an
 * unrecoverable one — the failure mode the boundary exists to prevent.
 */
export function reportError(
  error: Error & { digest?: string },
  context?: ReportErrorContext,
): void {
  let report: RedactedErrorReport;
  try {
    report = buildErrorReport(error, context);
  } catch {
    // Redaction itself failed (a getter on `error.message` threw, etc.). Report
    // the fact WITHOUT the un-redacted original — an unredactable error is
    // exactly the one that must not be forwarded verbatim.
    report = {
      message: "[reportError] failed to build a redacted report",
      context: {},
      ts: new Date().toISOString(),
    };
  }

  try {
    getErrorSink().send(report);
  } catch {
    // A broken provider adapter must not escalate the error it was reporting.
    // Fall back to the console so the report is not lost entirely.
    try {
      console.error("[reportError] sink threw; falling back to console", report);
    } catch {
      // Console itself is unavailable. Nothing further is safe to attempt.
    }
  }
}
