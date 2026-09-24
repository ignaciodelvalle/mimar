// Crash reporting — the answer to "the app closed itself and nobody knows why".
//
// WHY THIS EXISTS FOR THE PILOT: fourteen testers on unknown Android phones,
// none of whom will attach a logcat to an email. Without a crash reporter every
// native or JS crash is an unreproducible anecdote; with one it is a stack
// trace with a device model attached.
//
// WHERE THE DSN COMES FROM. `app.config.ts` reads `SENTRY_DSN` from the EAS
// build environment (it has no EXPO_PUBLIC_ prefix, so it never reaches
// `process.env` in the bundle) and carries it as `extra.sentryDsn`. A build
// without one — local dev, a fork, an emulator run — resolves to `null` and
// `initSentry` deliberately does nothing: an SDK initialized with a garbage
// DSN retries uploads forever, which is worse than absent.
//
// WHAT IS DELIBERATELY OFF:
//   · `sendDefaultPii` — stated even though it is the default. This product
//     hashes DNIs at the boundary (invariant #5); its crash reporter does not
//     get to be the one surface that ships identifying data by accident.
//   · Tracing (`tracesSampleRate: 0`) — the pilot's question is "does it
//     crash", not "is it fast". Performance spans multiply events against a
//     free-tier quota and can drown the one crash that mattered.
//   · `attachScreenshot` — OFF, and it is the option this product can least
//     afford (OBS-9). A screenshot of the crashing frame is the single most
//     useful debugging artifact there is, and on THIS app the crashing frame is
//     a libreta with a person's name on it, a denuncia naming a third party, or
//     a credential with a DNI's last four digits. `redactEvent` scrubs strings;
//     it cannot scrub a PNG. Turning this on is a privacy decision that belongs
//     to the PO and to `docs/architecture/privacy-controls.md`, never to a
//     convenience edit in a hotfix.
//   · `attachViewHierarchy` — OFF for the same reason and a weaker one: the
//     serialized hierarchy carries every rendered `Text` node's contents, so it
//     is the screenshot's data without its pixels.
//
// AND ONE THING DELIBERATELY ON (OBS-2, 2026-09-07): `enableCaptureFailedRequests`.
// A failed fetch is this app's most common invisible failure. Worth knowing what
// it does NOT cover: on Android the native HTTP-error layer needs the Sentry
// Gradle plugin, which is a native change and therefore not shippable over the
// air, so today this covers the JS fetch/XHR layer only. That is the layer this
// app's requests actually go through (`performRequest` in `api/client.ts`).
//
// AND THE THING THAT FLAG DOES THAT THIS FILE FIRST DESCRIBED WRONG (finding C2,
// review 2026-09-07). The sentence here used to read "the URLs it reports are
// `/api/v1` paths — never a bearer token", and it was wrong on the half that
// mattered. `@sentry/react-native`'s default integration list answers this flag
// by pushing `httpClientIntegration()` with NO options, so `@sentry/browser`'s
// defaults apply — every 5xx, every target — and its `_createEvent` writes
// `request: { url }` with the FULL url. A path under `/api/v1` is exactly where
// this product's pet tokens live: `/api/v1/pets/DIM-PAMP-0001/libreta` named an
// animal and, through its public page, its holder. `sendDefaultPii: false`
// suppresses the headers and the cookies on that block and has never had
// anything to say about the url. `redactEvent` now covers `request.url` and
// `request.query_string` — see `./redact`, which explains the shape.
//
// AND WHAT `sendDefaultPii: false` DOES NOT COVER — the gap this file carried
// until 2026-09-04. That flag stops the SDK ATTACHING identifying data of its
// own (IP, cookies, the user object). It has nothing to say about the strings
// the APP throws, and those are where this product's PII actually is: a DNI
// interpolated into a claim error, the e-mail an account was created with, a
// phone number off a lost-pet form, an access token echoed by a failed fetch.
// The web has scrubbed its own reports since task #56b
// (`lib/observability/redact.ts`); the two hooks below are that mechanism,
// applied to every event and every breadcrumb before either leaves the device.
// `./redact` explains which of the web's rules were ported and which were
// deliberately not.

import * as Sentry from "@sentry/react-native";
import Constants from "expo-constants";
import * as Updates from "expo-updates";

import { redactBreadcrumb, redactEvent } from "./redact";

/** The DSN the build carried, or null when this build has none. */
export function sentryDsnFromConfig(): string | null {
  const dsn: unknown = Constants.expoConfig?.extra?.sentryDsn;
  return typeof dsn === "string" && dsn.length > 0 ? dsn : null;
}

/**
 * Which release channel this bundle is running on, as Sentry's `environment`.
 *
 * WHY IT IS THE CHANNEL AND NOT `__DEV__` (OBS-10). Every OTA hotfix goes to
 * `preview` first and to `production` only after a device confirms it
 * (`docs/mobile/ota-policy.md`), so the question support asks about an event is
 * "was this the rehearsal or the fleet" — and without an environment every
 * event from both lands in one undifferentiated list.
 *
 * `Updates.channel` is `null` in a dev client and in an emulator run, where
 * expo-updates is disabled. "unknown" is deliberately not "development": this
 * app cannot tell those two apart, and inventing the distinction would put a
 * developer's label on a tester's phone whose updates module failed to load.
 */
export function sentryEnvironment(): string {
  const channel = Updates.channel;
  return typeof channel === "string" && channel.length > 0 ? channel : "unknown";
}

/**
 * Initialize crash reporting, or refuse out loud in the return value.
 *
 * Returns whether the SDK actually started, so the caller can log the refusal
 * in dev instead of wondering why a test crash never arrived.
 */
let started = false;

/**
 * Did crash reporting actually start on THIS launch? (OBS-8)
 *
 * Ajustes prints this, and it prints the measured fact rather than the intent.
 * "The build has a DSN" and "the SDK is running" came apart twice during the
 * pilot prep — a DSN that Expo's config serialization turned into `{}`, and a
 * dev client where the module is present and inert — and in both cases the only
 * way to find out was that no event ever arrived. A tester who can read
 * "Reporte de errores: inactivo" off their own phone answers that in a second.
 */
export function crashReportingActive(): boolean {
  return started;
}

export function initSentry(): boolean {
  const dsn = sentryDsnFromConfig();
  if (dsn === null) return false;
  Sentry.init({
    dsn,
    environment: sentryEnvironment(),
    sendDefaultPii: false,
    tracesSampleRate: 0,
    attachScreenshot: false,
    attachViewHierarchy: false,
    enableCaptureFailedRequests: true,
    // BOTH HOOKS, not one. `beforeSend` sees the breadcrumbs already attached to
    // an event, and `beforeBreadcrumb` sees each one as it is recorded — but
    // only the second runs for breadcrumbs the SDK itself synthesises before an
    // event exists, and only the first runs for an event assembled without going
    // through the breadcrumb buffer. Either alone leaves a channel open.
    beforeSend: (event) => redactEvent(event),
    beforeBreadcrumb: (breadcrumb) => redactBreadcrumb(breadcrumb),
  });
  started = true;
  return true;
}
