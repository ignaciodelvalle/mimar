// Client error telemetry — the browser's errors stop dying in the tab.
//
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
// ---------------------------------------------------------------------------
// Option B of `docs/architecture/client-error-sink-pending-decision.md`: an
// endpoint that re-emits an ALREADY-REDACTED client error report through
// `lib/infra/report-error.ts`, the same reporter the server already uses, so it
// lands in the Vercel function logs the team already reads.
//
// It introduces NO new data processor. Vercel already processes every request
// this app serves, so the art. 12 transfer analysis that gates a hosted APM
// (Sentry et al.) does not apply here — which is exactly why that document
// recommends doing this first regardless of which vendor is eventually chosen:
// "If only one thing is done, it should be B, because it is the one with no
// gate in front of it."
//
// It is NOT a replacement for an APM. There is no grouping, no dedup, no
// alerting on a spike and no symbolication. One noisy bug produces one log line
// per occurrence. That is the trade, and it is written down rather than
// discovered later.
//
// WHY THE VALIDATION BELOW IS SO STRICT
// ---------------------------------------------------------------------------
// This is a PUBLIC endpoint — an error boundary fires for a logged-out visitor,
// so requiring a session would silence exactly the reports that matter most.
// Public plus "writes to the log the team reads" means every field here is
// hostile input until proven otherwise:
//
//   · Sizes are capped. `reportError` JSON-encodes, so a newline cannot forge a
//     log line — but an unbounded `stack` can still flood the log, and flooding
//     a log is how you hide the line that mattered.
//   · `context` is a CLOSED allowlist of five keys, primitives only, bounded in
//     count. Anything else is dropped — an object there would serialise to
//     arbitrary depth, and an unlisted key is a field nobody reviewed.
//   · The client's `ts` is IGNORED. The reporter stamps its own. A timestamp a
//     caller chooses is a timestamp a caller can use to sort its line somewhere
//     else in the log.
//   · TWO rate limits, per caller IP and global. The per-IP one bounds the
//     broken tab; the global one bounds the flood that is not per-IP, because
//     this endpoint takes a cross-origin POST with no preflight and any page can
//     make all of its visitors post here from their own addresses.
//
// The redaction that matters already happened in the browser, in
// `lib/observability/report-error.ts`, BEFORE the report reached the network.
// This route does not re-redact and must not be read as if it did: it cannot
// un-leak a field the client sent. What it can do — and does — is refuse a
// shape it was not promised.
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";

export const dynamic = "force-dynamic";

/** Caps. Generous enough for a real stack, small enough that a loop cannot flood. */
const MAX_MESSAGE = 500;
const MAX_STACK = 4000;
const MAX_NAME = 100;
const MAX_DIGEST = 100;
const MAX_CONTEXT_KEYS = 20;
const MAX_CONTEXT_VALUE = 300;
const MAX_BODY_BYTES = 16_000;

/**
 * Per-IP budget.
 *
 * A browser that is genuinely broken reports a handful of times and stops or
 * reloads. Sixty a minute leaves room for a burst on a bad deploy without
 * letting one tab own the log.
 */
const RATE_LIMIT = { maxPerMinute: 60, maxPerHour: 600 };

/**
 * The GLOBAL ceiling, and the reason it exists is that the per-IP one does not
 * address the threat this endpoint actually carries.
 *
 * The first version had only the per-IP budget. Per-IP is the right shape for
 * one broken tab and the wrong shape for the flood that matters: this route
 * takes a cross-origin POST with no preflight — no `Origin` check, and a
 * `text/plain` body is a simple request — so any third-party page can make EVERY
 * ONE OF ITS VISITORS post here, each from its own residential IP, each well
 * inside its own budget. Sixty a minute times N visitors, against a bounded log
 * retention, with nothing summing them.
 *
 * A shared bucket turns that into a 429. It is deliberately NOT tight: 2000 a
 * minute is far above anything the real user base can produce and far below what
 * a distributed flood needs to bury a day of logs. It bounds the blast radius;
 * it does not try to be a WAF.
 */
const GLOBAL_RATE_LIMIT = { maxPerMinute: 2000, maxPerHour: 40_000 };

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, max);
}

/**
 * The CLOSED allowlist of caller-context keys, mirroring
 * `ALLOWED_CONTEXT_KEYS` in `lib/observability/report-error.ts`.
 *
 * IT IS A REAL LIST NOW, AND THE FIRST VERSION ONLY SAID IT WAS. That version's
 * comment claimed to mirror the browser's closed allowlist and then accepted ANY
 * key matching `/^[A-Za-z0-9_.-]{1,64}$/` — its own test proved it, sending
 * `ok`/`num`/`si` and asserting they survived.
 *
 * Why that matters beyond the prose being wrong: the privacy checklist says
 * project the fields you need, never ship the bag, and the browser-side list is
 * declared as THE REVIEW POINT for adding one. A regex here is not a review
 * point — a new call site could hang a field on the context and reach the log
 * with nothing objecting.
 *
 * Adding a key here is a decision: it must exist on the browser's list too, or
 * it can never arrive, and it must be a field this application GENERATES rather
 * than one a page interpolated from whatever it was holding.
 */
const ALLOWED_CONTEXT_KEYS = new Set(["route", "homeHref", "source", "correlationId", "boundary"]);

/**
 * The allowlisted, primitives-only projection of caller context.
 *
 * Repeated here and not trusted from the wire for the reason every boundary in
 * this repo repeats: the client is not a guard, it is a suggestion.
 */
function sanitizeContext(value: unknown): Record<string, string | number | boolean> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string | number | boolean> = {};
  let kept = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (kept >= MAX_CONTEXT_KEYS) break;
    if (!ALLOWED_CONTEXT_KEYS.has(key)) continue;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = raw;
    } else if (typeof raw === "boolean") {
      out[key] = raw;
    } else if (typeof raw === "string") {
      const s = str(raw, MAX_CONTEXT_VALUE);
      if (s === undefined) continue;
      out[key] = s;
    } else {
      continue;
    }
    kept += 1;
  }
  return out;
}

// @no-auth-required: un error boundary dispara para cualquier visitante, incluido
// uno sin sesión — pedir sesión acá silenciaría exactamente los reportes que más
// importan, los de la credencial pública y los del wizard de denuncia anónima.
// El endpoint es de SOLA ESCRITURA y no devuelve nada: un 204 vacío, o un 400
// cuando la forma no es la prometida. No lee, no consulta, no expone un estado
// que un llamador pudiera sondear. Lo que sí necesita —porque escribe en el log
// que el equipo lee— está abajo y no es autorización sino contención: DOS
// límites de tasa (por IP del llamador y global, porque la inundación que
// importa no es por IP), tope de cuerpo medido en bytes, topes por campo, y un
// contexto acotado a una lista blanca cerrada de cinco claves.
export async function POST(req: NextRequest): Promise<NextResponse> {
  // Rate limit BEFORE reading the body: a caller that is over budget should not
  // get to make the server parse 16 KB to find that out.
  //
  // TWO BUDGETS, because one flood is per-caller and the other is not. See
  // GLOBAL_RATE_LIMIT above for why the per-IP one alone is the wrong shape.
  let limiterFailed = false;
  try {
    const ip = callerIp(req.headers);
    await enforceRateLimit("telemetry-client-error", ip, RATE_LIMIT);
    await enforceRateLimit("telemetry-client-error-global", "all", GLOBAL_RATE_LIMIT);
  } catch (err) {
    if (err instanceof RateLimitError) {
      return new NextResponse(null, { status: 429 });
    }
    // The limiter itself failing must not swallow the report: a telemetry
    // endpoint that fails closed on its own infrastructure hiccup loses exactly
    // the reports a bad deploy produces.
    //
    // BUT IT MUST NOT WRITE ITS OWN LINE EITHER, and the first version did. The
    // limiter is backed by a table; when that table is unavailable, EVERY
    // anonymous request produces two log lines instead of one, unbounded, at
    // precisely the moment the team is reading the log. The signal survives as a
    // flag on the report that is about to be written anyway — same information,
    // one line, and it cannot outrun the thing it describes.
    limiterFailed = true;
  }

  const raw = await req.text();
  // BYTES, not `raw.length`. The first version compared the cap against string
  // length, which is UTF-16 units: 16.000 characters in the U+0800-U+FFFF range
  // are 48.000 bytes, so the real ceiling was up to three times the named one.
  //
  // What this bounds honestly is the cost of the parse and of the line written,
  // NOT memory or bandwidth: `req.text()` has already buffered the whole body by
  // the time this runs. The body size itself is bounded by the platform
  // (Vercel's serverless request limit), not here.
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return new NextResponse(null, { status: 400 });
  }

  const body = parsed as Record<string, unknown>;
  const message = str(body.message, MAX_MESSAGE);
  // A report with no message is not a report. Refusing it keeps the log free of
  // lines that say nothing, which is the failure mode of every telemetry
  // endpoint that accepts whatever it is handed.
  if (message === undefined) {
    return new NextResponse(null, { status: 400 });
  }

  const name = str(body.name, MAX_NAME);
  const stack = str(body.stack, MAX_STACK);
  const digest = str(body.digest, MAX_DIGEST);
  const context = sanitizeContext(body.context);

  // Shaped like an Error so the reporter's own serialisation applies unchanged,
  // and tagged `client` so a log search can tell the two halves apart. `ts` is
  // NOT carried over: reportError stamps the server's clock.
  const err = Object.assign(new Error(message), {
    name: name ?? "ClientError",
    stack: stack ?? undefined,
  });

  reportError("client", err, {
    ...context,
    ...(digest ? { digest } : {}),
    ...(limiterFailed ? { limiter_unavailable: true } : {}),
    surface: "browser",
  });

  return new NextResponse(null, { status: 204 });
}
