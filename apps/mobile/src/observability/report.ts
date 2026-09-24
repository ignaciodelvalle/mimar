// Handled failures — the half of observability a crash reporter cannot see.
//
// WHY THIS EXISTS (OBS-2, native audit tanda A). `Sentry.wrap` in
// `app/_layout.tsx` catches what CRASHES. This app's most expensive failures do
// not crash: `client.ts` answers `malformed`, `unsupported-version` or an
// unexpected `api-error` and every screen renders an honest sentence — which is
// exactly right for the person and completely invisible to us. Fourteen pilot
// testers reading "el servidor respondió algo que no pudimos leer" produce zero
// events, so a contract break on one endpoint looks identical to a good week.
//
// TAGS ARE A CLOSED UNION, AND THAT IS A PRIVACY RULE, NOT A STYLE
// ---------------------------------------------------------------------------
// `redactEvent` (./redact) scrubs the message, the exception values, the extra
// bag and the breadcrumb trail. It does NOT scrub tags, and it should not have
// to: Sentry INDEXES tags, so a tag is the one field on an event that is
// searchable, aggregated and shown in a list. Nothing free-form may go there.
// Every tag this module writes comes from a union declared in this file or in
// `@dim/contract/api` — a value that cannot be a DNI, an e-mail, a phone
// number or a token because it cannot be anything but one of a handful of
// literals.
//
// THE CORRELATION ID (OBS-3) IS THE RETURN VALUE, AND THAT IS THE POINT
// ---------------------------------------------------------------------------
// A tester says "no me dejó entrar". Without a shared token the only way to
// find their event is to guess at a timestamp across fourteen phones. This
// mints eight hex characters per failure, tags the event with them, and hands
// them back so the notice on screen can print "Código: 3f9a1c02" — short enough
// to read out over WhatsApp, long enough (4.3 billion) that two failures in one
// pilot week will not collide.
//
// It is NOT a request id: the server does not know it and never sees it. It
// correlates ONE screen with ONE Sentry event, which is the question support
// actually asks.

import type { ApiV1ErrorCode } from "@dim/contract/api";
import * as Sentry from "@sentry/react-native";

/** Which part of the app produced the failure. Closed: it becomes a tag. */
export const REPORT_SURFACES = ["api", "auth", "update", "push"] as const;
export type ReportSurface = (typeof REPORT_SURFACES)[number];

/**
 * What went wrong, in the vocabulary the app already reasons in.
 *
 * The first four are `ApiResult`'s failure arms minus `unreachable` — a phone
 * with no signal is not a defect and reporting it would drown the file in
 * events from the subway. `refresh-refused` and `refresh-unreachable` are the
 * auth surface's own two (OBS-6).
 */
export const REPORT_FAILURES = [
  "malformed",
  "unsupported-version",
  "api-error",
  "refresh-refused",
  "refresh-unreachable",
  "update-check-failed",
  // The other two thirds of the OTA button, kept apart from the check because
  // they mean different things to whoever reads the file: a check that fails on
  // every phone is a broken update URL, a DOWNLOAD that fails is a bundle the
  // server will not serve to this fingerprint, and a RESTART that fails is a
  // device that took a staged update and would not apply it.
  "update-download-failed",
  "update-restart-failed",
  // THE PUSH SURFACE'S TWO, AND NEITHER OF THEM IS "a notification did not
  // arrive" — that is unobservable from here and always will be.
  //
  // `push-revoke-failed` is the one with teeth. A person ending a session asked
  // for delivery to this device to STOP; when the request carrying that does not
  // land, the row stays live and the phone keeps lighting up. The sign-out
  // itself is deliberately unaffected — somebody leaving is leaving — so without
  // an event here the failure is invisible on both sides: nothing on screen,
  // nothing in the file, and a lock screen that keeps ringing.
  "push-revoke-failed",
  // `push-not-configured` is the BUILD saying it cannot receive at all, which on
  // Android almost always means the FCM credential is missing from the binary
  // (see expo-push-adapter.ts). It is not a person's problem and shows nothing;
  // it exists so "push works on iOS and silently not on Android" is a question
  // the file can answer instead of a thing somebody notices in a demo.
  "push-not-configured",
] as const;
export type ReportFailure = (typeof REPORT_FAILURES)[number];

export type HandledFailure = {
  surface: ReportSurface;
  failure: ReportFailure;
  /** The contract's own closed vocabulary, when the failure carried one. */
  code?: ApiV1ErrorCode;
  /**
   * The route TEMPLATE, never a filled path. `/api/v1/pets/:token`, not the
   * token — a pet's public token identifies an animal and its owner, and a tag
   * is indexed forever.
   */
  route?: string;
};

const HEX = "0123456789abcdef";
/** Eight characters: readable out loud, and 4.3e9 wide. See the header. */
const CORRELATION_ID_LENGTH = 8;

/** Eight hex characters. Not a UUID: a person has to read this one aloud. */
export function newCorrelationId(): string {
  let out = "";
  for (let index = 0; index < CORRELATION_ID_LENGTH; index += 1) {
    out += HEX[Math.floor(Math.random() * HEX.length)];
  }
  return out;
}

/** True for the shape `newCorrelationId` produces. Used by the notice and its test. */
export function isCorrelationId(value: string): boolean {
  return value.length === CORRELATION_ID_LENGTH && /^[0-9a-f]+$/.test(value);
}

/**
 * Report a failure the app HANDLED, and return the id the screen should print.
 *
 * Never throws. An observability call that can take down the screen it is
 * observing has inverted its own purpose — `Sentry.captureException` on a
 * client that never initialized (a build with no DSN, which is every local run)
 * is a no-op today, but that is the SDK's promise and not ours.
 */
export function reportHandledFailure(failure: HandledFailure): string {
  const correlationId = newCorrelationId();
  try {
    Sentry.captureException(new Error(`${failure.surface}/${failure.failure}`), {
      tags: {
        surface: failure.surface,
        failure: failure.failure,
        // "none" rather than an absent key: a tag that is sometimes missing
        // cannot be grouped on in Sentry's UI, and "none" is a fact.
        api_error_code: failure.code ?? "none",
        route: failure.route ?? "none",
        correlation_id: correlationId,
      },
    });
  } catch {
    // Deliberately silent. See the docblock.
  }
  return correlationId;
}

// ---------------------------------------------------------------------------
// Breadcrumbs — the trail in front of the event (OBS-5, OBS-6)
// ---------------------------------------------------------------------------

/**
 * A path with every identifying segment replaced by `:id`.
 *
 * Used for BOTH the API route tag and the navigation breadcrumb, and the reason
 * is the same in both places: a pet's public token identifies an animal and,
 * through its public page, its holder; a share token grants a read. Neither may
 * be aggregated into a searchable dimension or written into a trail that ships
 * with every crash, just because it happened to be in a URL.
 *
 * The rule is deliberately paranoid rather than clever: a segment survives only
 * if it is entirely lowercase kebab and carries no digit. `api` and `v1` are
 * named literally so the version prefix is not mistaken for an id.
 *
 * THE RESIDUAL RISK, STATED (nit N5, review 2026-09-07). `/^[a-z][a-z-]*$/` is
 * "what looks like a word", which is not the same question as "what is not an
 * identifier" — it is a proxy for it, and the proxy has a gap on both sides:
 *
 *   · A slug that is genuinely identifying but happens to be lowercase kebab
 *     with no digit — an org handle, a vanity locality, a future
 *     `/refugio/patitas-felices` — survives this filter and lands in a tag or a
 *     breadcrumb. Nothing in the product mints one today; nothing stops one.
 *   · A route segment that is a real word but carries a digit (`v2`, `tier2`)
 *     is turned into `:id`, which costs a little legibility and no privacy.
 *
 * The trade is deliberate and is the safe direction — this over-redacts and
 * under-leaks — but it is a proxy, and the day a human-readable slug becomes
 * part of a URL is the day this needs a real answer rather than a shape test.
 */
export function telemetryPath(path: string): string {
  const withoutQuery = path.split("?")[0] ?? path;
  return withoutQuery
    .split("/")
    .map((segment) => {
      if (segment === "" || segment === "api" || segment === "v1") return segment;
      return /^[a-z][a-z-]*$/.test(segment) ? segment : ":id";
    })
    .join("/");
}

/**
 * What happened to the session. Closed union: it is written into a breadcrumb.
 *
 * NO TOKEN, NO E-MAIL, NO USER ID may ever be added here, and the union is the
 * mechanism rather than a rule in a comment — `addAuthBreadcrumb` takes nothing
 * else. `redactBreadcrumb` would scrub an e-mail out of a free-form message,
 * but an access token is 800 characters of base64 that no pattern recognises,
 * and that is precisely the string a debugging session is tempted to log.
 */
export const AUTH_EVENTS = [
  "refresh-ok",
  "refresh-refused",
  "refresh-unreachable",
  "sign-out",
  "session-restored",
] as const;
export type AuthEvent = (typeof AUTH_EVENTS)[number];

/**
 * Note a session transition on the trail.
 *
 * WHY THESE FIVE AND NOT A LOG LINE PER BRANCH (OBS-6). Every session defect
 * this app has had reads the same in a bug report — "me sacó de la sesión" —
 * and the four causes (a refusal, a dead spot, a deliberate sign-out, a
 * keystore restore that lost a race) are indistinguishable after the fact. The
 * breadcrumbs before a crash or a handled failure are the only place that
 * ordering survives.
 */
export function addAuthBreadcrumb(event: AuthEvent): void {
  try {
    Sentry.addBreadcrumb({ category: "auth", level: "info", message: event });
  } catch {
    // See `reportHandledFailure`: observability may not break what it observes.
  }
}

/** Note a screen change on the trail, with every id stripped. See `telemetryPath`. */
export function addNavigationBreadcrumb(pathname: string): void {
  try {
    Sentry.addBreadcrumb({
      category: "navigation",
      level: "info",
      message: telemetryPath(pathname),
    });
  } catch {
    // See `reportHandledFailure`.
  }
}
