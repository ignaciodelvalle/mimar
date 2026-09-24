// The transport that makes `reportError` reach someone.
//
// Pairs with `app/api/telemetry/client-error/route.ts` — option B of
// `docs/architecture/client-error-sink-pending-decision.md`. The report it
// sends is ALREADY REDACTED: `lib/observability/report-error.ts` scrubs, then
// dispatches to whatever sink is installed. This file is a transport and
// nothing else, which is the seam's whole point — putting redaction behind it
// would mean the next adapter re-implements it and the first one to get it
// wrong leaks silently.
//
// WHY `sendBeacon` FIRST, AND WHY THAT IS NOT A DETAIL
// ---------------------------------------------------------------------------
// The moment an error boundary fires is very often the moment the page is about
// to go away — the person hits reload, or navigates off the broken screen. A
// plain `fetch` issued there is CANCELLED when the document unloads, and the
// report is lost. Which reports? Precisely the ones from errors bad enough that
// somebody gave up on the page: the ones most worth having.
//
// `navigator.sendBeacon` is the browser API built for that case: the request is
// queued by the user agent and survives unload. It has two constraints worth
// knowing before changing anything here:
//
//   · It cannot set `Content-Type: application/json` from a string body — a
//     string becomes `text/plain`. So the body is a `Blob` with the type set
//     explicitly, which is the supported way.
//   · It returns `false` when the browser refuses to queue (payload over the
//     agent's limit, or the API unavailable). That is not an error, it is a
//     refusal — and it is why the `fetch` fallback below exists rather than the
//     report being dropped.
//
// The fallback uses `keepalive: true` for the same unload reason.
//
// NOTHING HERE MAY THROW. This runs inside a React error boundary. A reporter
// that throws while reporting turns a recoverable error screen into an
// unrecoverable one — the `ErrorSink` contract says `send` must not throw, and
// this file honours it with a `try` around every branch rather than trusting
// that none of them can.
import type { ErrorSink, RedactedErrorReport } from "@/lib/observability/sink";

/** Where the redacted report goes. Same-origin, so no CORS and no preflight. */
export const CLIENT_ERROR_ENDPOINT = "/api/telemetry/client-error";

/**
 * Serialises the report for the wire.
 *
 * Exported for the test: a payload that cannot be serialised is a report that
 * silently never arrives, and that is the failure this whole file exists to
 * end. Returns `null` when the report cannot be encoded, so the caller can
 * decide (and, here, fall back to the console rather than lose it).
 */
export function encodeReport(report: RedactedErrorReport): string | null {
  try {
    return JSON.stringify(report);
  } catch {
    return null;
  }
}

/**
 * Posts the redacted report to this app's own telemetry route.
 *
 * `name` is "beacon" and not "vercel": what the endpoint does with the report
 * is the endpoint's business, and naming the transport after today's log
 * destination would be one more claim to keep true later.
 */
export const beaconSink: ErrorSink = {
  name: "beacon",
  send(report: RedactedErrorReport): void {
    const body = encodeReport(report);
    if (body === null) {
      // Unserialisable — keep the console line rather than dropping the report
      // on the floor. A developer with the console open still sees it.
      console.error("[reportError] unserialisable report", report);
      return;
    }

    try {
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        const blob = new Blob([body], { type: "application/json" });
        // `false` means the agent refused to queue it — fall through to fetch.
        if (navigator.sendBeacon(CLIENT_ERROR_ENDPOINT, blob)) return;
      }
    } catch {
      // Some agents throw instead of returning false. Same remedy.
    }

    try {
      void fetch(CLIENT_ERROR_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
        // The response carries nothing the page needs, and reading it would
        // hold the request open past the unload this transport exists to
        // survive.
      }).catch(() => {
        // A telemetry POST that fails is not worth a second error. Swallow it
        // HERE, at the transport, and not upstream where it would be
        // indistinguishable from the error being reported.
      });
    } catch {
      console.error("[reportError] transport unavailable", report);
    }
  },
};
