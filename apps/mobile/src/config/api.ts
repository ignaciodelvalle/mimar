// Where the app talks to — the DATA plane and the AUTH plane, which are not the
// same host and must not be confused for one.
//
// THE EMPTY-STRING TRAP, WHICH THIS REPO HAS ALREADY PAID FOR ONCE
// ---------------------------------------------------------------------------
// `process.env.X ?? DEFAULT` is wrong here and the web app has the scar to
// prove it: an env var that is DEFINED BUT EMPTY (a `.env` line with nothing
// after the `=`, a CI variable declared and never filled) passes `??` — it is
// not nullish — and the empty string wins. In the web credential that produced
// a QR encoding a host-less relative URL, which no phone camera can resolve;
// the code that shipped it looked exactly as correct as `??` looks here.
//
// So: trim first, then fall back on anything falsy. Under Expo these values are
// INLINED by babel at bundle time — `EXPO_PUBLIC_API_BASE_URL` is substituted
// as a literal, not read from a runtime environment — which means a build made
// with the variable empty carries the empty string into the binary and there is
// no later opportunity to notice.
//
// TWO PLANES, ONE RULE
// ---------------------------------------------------------------------------
// DATA (pets, events, custody, the credential) goes through `/api/v1` with a
// bearer token, never through PostgREST — PO decision #2. It was taken because
// 14 of 15 `ownerships`-derived RLS policies carried no role predicate and the
// `pet_events` INSERT policy checked neither role nor event type (RLS audit
// 2026-08-18); migration 0212 (2026-09-02) has since dropped that policy, so
// `pet_events` now has no caller-facing write surface at all. The decision
// stands on its own terms regardless: the data plane belongs behind
// `requireLiveUser` / `requirePetAccess` and the app's own validation, and a
// bearer token pointed at PostgREST bypasses every one of them by design.
// AUTH (token refresh) goes to GoTrue directly, because that is what the Supabase SDK does
// on a timer and is unambiguously better at than a hand-rolled endpoint (clock
// skew, concurrent-refresh collapsing, retry). The two constants below are
// separate so nothing can quietly start reading tables with the auth client.

import { deepLinkUrl } from "@dim/contract/links";

/** Trim, then reject empty — see the header. */
function envUrl(raw: string | undefined, fallback: string): string {
  const trimmed = raw?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : fallback;
}

/** Same rule, for a value with no sensible default. */
function envValue(raw: string | undefined): string {
  return raw?.trim() ?? "";
}

/**
 * The API/web origin.
 *
 * Defaults to staging because that is where the flagship demo pet lives.
 * Override with `EXPO_PUBLIC_API_BASE_URL` (e.g. an ngrok tunnel to a local
 * `next dev` — a phone cannot reach `localhost`).
 */
export const API_BASE_URL = envUrl(
  process.env.EXPO_PUBLIC_API_BASE_URL,
  "https://dim-staging.vercel.app",
);

/**
 * The GoTrue origin and its publishable key, for TOKEN REFRESH ONLY.
 *
 * NO DEFAULT, deliberately, and this is the one place in this file that refuses
 * to guess. A wrong API origin produces a visible failure on the first screen; a
 * wrong auth origin produces an app that signs in fine and then silently stops
 * refreshing an hour later, which surfaces as "it logs me out sometimes" — the
 * exact symptom class this whole auth stack was written to avoid. Empty means
 * `authPlaneConfigured()` is false and the app says so, out loud, instead of
 * pretending.
 *
 * The anon key is publishable by design: it identifies the project and grants
 * nothing on its own. It is still read from the environment rather than pinned
 * here so a build can point at a different project without a code change.
 */
export const SUPABASE_URL = envValue(process.env.EXPO_PUBLIC_SUPABASE_URL).replace(/\/+$/, "");
export const SUPABASE_ANON_KEY = envValue(process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY);

/** Whether this build can refresh a session at all. See SUPABASE_URL. */
export function authPlaneConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
}

/**
 * A host that is the developer's machine or network, from the device's point
 * of view.
 *
 * `localhost`/`127.0.0.1` are the web and simulator spellings, `10.0.2.2` and
 * `10.0.3.2` the Android emulators' aliases for the host loopback (covered by
 * the 10/8 range below), `.local` an mDNS name. The RFC 1918 ranges are the
 * spelling a PHYSICAL device on the developer's wifi actually uses
 * (`http://192.168.x.x:3000`) — the 2026-09-01 pre-push review measured that
 * the original enumerated list missed exactly that one, so the crossed-planes
 * message stayed generic on a real phone, the device this check most needs to
 * speak on; and the reverse hole too: one machine wearing two spellings (LAN
 * IP for one plane, emulator alias for the other) read as "dos entornos". A
 * private address is never a public deployment, so "RFC 1918" and "the
 * machine the developer is sitting at" coincide for every build this app can
 * make.
 */
function isLocalHost(host: string): boolean {
  return (
    host === "localhost" || host === "127.0.0.1" || host.endsWith(".local") || isPrivateLanIp(host)
  );
}

/** RFC 1918: 10/8 (includes the emulator aliases), 172.16/12, 192.168/16. */
function isPrivateLanIp(host: string): boolean {
  if (host.startsWith("10.") || host.startsWith("192.168.")) return true;
  const octets = host.match(/^172\.(\d{1,3})\./);
  return octets !== null && Number(octets[1]) >= 16 && Number(octets[1]) <= 31;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * True when the two planes point at DIFFERENT ENVIRONMENTS — one local, one not.
 *
 * NOT "different hosts", and the distinction is the whole point. The header says
 * these two are deliberately different hosts: in staging the data plane is
 * `dim-staging.vercel.app` and the auth plane is a `*.supabase.co` project. A
 * fence asserting they match would be red on every correct configuration this
 * app ships with.
 *
 * What is never correct is a build that CROSSES environments, and it produces a
 * failure that reads as anything but its cause. Measured on 2026-08-30: with
 * `EXPO_PUBLIC_SUPABASE_URL` pointed at a local stack and
 * `EXPO_PUBLIC_API_BASE_URL` left on its staging default, the app signs in at
 * STAGING, receives an access token signed with staging's key, and hands it to
 * LOCAL GoTrue — which answers `invalid JWT: unrecognized JWT kid <…> for
 * algorithm ES256`. `setSession` calls `_getUser` over the network before it
 * saves anything, so nothing on the device is ever touched, and the sign-in
 * screen reported a device-storage problem. That was investigated as an
 * unexplained Keystore fault: an emulator PIN tried and refuted, `adb logcat`
 * searched for SecureStore lines that could not exist.
 *
 * Returns false when either origin is missing or unparseable — those are
 * `authPlaneConfigured()`'s business, and answering "crossed" for an
 * unconfigured build would put a second explanation on a screen that already has
 * the right one.
 */
export function planesLookCrossed(): boolean {
  const apiHost = hostOf(API_BASE_URL);
  const authHost = SUPABASE_URL.length > 0 ? hostOf(SUPABASE_URL) : null;
  if (apiHost === null || authHost === null) return false;
  return isLocalHost(apiHost) !== isLocalHost(authHost);
}

/**
 * The URL the QR encodes: the PUBLIC WEB PAGE, not this app and not the API.
 *
 * Invariant #1 — the pet is the credential — means the code has to resolve for
 * whoever scans it, and that is a stranger with a phone camera and no miMAR
 * install. `mimar://` would resolve for nobody; the API URL would hand them
 * JSON. Once verified App Links land (see `app.config.ts`) this exact `https`
 * URL starts opening the app for people who DO have it installed, and keeps
 * working unchanged for everyone else. That is why the QR must encode it now.
 *
 * The PATH comes from `@dim/contract/links` — the same table the web app builds
 * its own `/p/{token}` links from. It used to be a template literal here, which
 * meant the app and the server each carried a private opinion about where the
 * credential lives; a rename on one side produced a QR that resolved to a 404
 * and no compile error anywhere. The origin stays local, because only this
 * build knows which backend it points at.
 */
export function publicCredentialPageUrl(publicToken: string): string {
  return deepLinkUrl(API_BASE_URL, "credential", { publicToken });
}

/**
 * The invitation link for one caretaker grant — the URL the titular can hand
 * over themselves (A4-custodia-10).
 *
 * WHY THE TITULAR NEEDS IT AT ALL. When the invited address has no miMAR
 * account the native write deliberately sends no e-mail — a magic link would
 * land the recipient in a browser session on a phone that has this app — so the
 * ack says "avisale vos". It said that while giving them nothing to hand over:
 * the sister signs up, finds nothing, and the titular has no link to forward.
 *
 * Same origin and same table as `publicCredentialPageUrl`: the path comes from
 * `@dim/contract/links`, which is what the invitation e-mail and the
 * notification CTA both build `/cuidado/{token}` from, so a rename moves all
 * three at once. Once verified App Links land this URL opens the app for
 * somebody who has it and the browser for everybody else, which is exactly the
 * behaviour an invitation to a person with no account needs.
 */
export function caretakerGrantPageUrl(grantToken: string): string {
  return deepLinkUrl(API_BASE_URL, "caretakerGrant", { grantToken });
}

/**
 * The web URL where identity completion happens, for the pending-profile gate.
 *
 * `/registro` and not a native form: there is no native identity flow and this
 * app must not fake one. The DNI hashing, the Ley 25.326 consent copy and the
 * Mi Argentina federation path all live on the web today, and a native form
 * posting "some fields" would be a second, weaker definition of what a verified
 * identity is.
 *
 * It is the RESUME surface by design — `app/(auth)/registro/page.tsx` keeps an
 * authenticated visitor whose identity is still provisional on the page and
 * shows step 2 directly, instead of bouncing them to `/mis-mascotas`. (That
 * guard exists because it used to bounce them, which is how 60% of owner
 * profiles ended up stuck on the trigger's provisional display name.)
 *
 * WHAT THE SCREEN MUST SAY, because this URL does not carry the native session:
 * the web resolves the visitor from a COOKIE and this app holds a bearer token,
 * so opening the link lands on a signed-out browser. The person has to sign in
 * again there with the same email. Saying so is the difference between a link
 * that works and a link that looks broken.
 *
 * `?from=app` IS THE HANDOFF MARKER, and it is why this link stops landing a
 * tester on a signup form (native QA batch 2, D6). The browser opens SIGNED OUT
 * — that is the paragraph above — so `/registro` had no way to tell this visitor
 * from a stranger and showed "Crear cuenta · Paso 1 de 2": the natural action on
 * the screen was to create a SECOND account for somebody who already has one.
 * With the marker the page leads with "Ya tenés cuenta en miMAR: iniciá sesión
 * para completar tu registro", and its login link carries `returnTo` back to
 * this same URL, so signing in lands on step 2 instead of on `/mis-mascotas`
 * with a banner to notice.
 *
 * IT AUTHORIZES NOTHING. It is a query parameter anybody can paste; the signup
 * form is still rendered underneath. All it decides is which door is offered
 * first, which is exactly as much trust as a query parameter has earned.
 *
 * NO CALLER SINCE 2026-09-07, and that is recorded rather than resolved. The one
 * call site — `IdentidadPendienteScreen`'s "Prefiero completarlo en la web" —
 * went with the DNI field it led to. The constant stays for two reasons, neither
 * of them "it might come back": the two constants below refer to it BY NAME to
 * explain why THEY need no lost-session warning, so deleting it turns two live
 * explanations into dangling references; and the `?from=app` marker it composes
 * is still handled on the web (`app/(auth)/registro/page.tsx`) for app builds
 * already in the field, so the shape is still real even though nothing here
 * builds it. If Mi Argentina lands and this file no longer needs a web door at
 * all, delete it WITH those two comments, not before them.
 */
export const IDENTITY_COMPLETION_URL = `${API_BASE_URL}/registro?from=app`;

/**
 * The two legal documents the crear-cuenta checkbox accepts.
 *
 * THEY OPEN IN THE BROWSER, and that is not a shortcut around a missing native
 * screen. These pages are the LEGAL text (Ley 25.326 and the Términos), they
 * are versioned and served by the web app, and a native copy of them would be
 * a second version of a document whose whole value is that there is one. The
 * web signup links to `/terminos` and `/privacidad` from the same checkbox
 * (app/(auth)/registro/SignupForm.tsx); these are the same two hrefs.
 *
 * Unlike IDENTITY_COMPLETION_URL neither needs a warning about a lost session:
 * both are public pages and read the same signed out.
 */
export const TERMS_URL = `${API_BASE_URL}/terminos`;
export const PRIVACY_URL = `${API_BASE_URL}/privacidad`;

/**
 * The web URL where an account is deleted — a GOOGLE PLAY POLICY REQUIREMENT,
 * not a convenience.
 *
 * Play's "Data deletion" requirement applies to any app that lets a user CREATE
 * an account, and this one does: `/crear-cuenta` is a native screen posting to
 * `POST /api/v1/auth/signup` (src/api/endpoints.ts). The rule asks for two
 * things — an IN-APP route to deletion, and a web URL that can be pasted into
 * the Play Console's Data safety form. An app that offers signup and nothing
 * else is rejected before a human ever opens it. Before this constant existed,
 * `app/ajustes.tsx` offered sign-out and revoke-all-sessions and nothing that
 * ended the account.
 *
 * NO LONGER THE PRIMARY PATH (WU-R, 2026-08-29), AND THE ARGUMENT THAT MADE IT
 * ONE IS RECORDED RATHER THAN DELETED — the same treatment
 * `PASSWORD_RECOVERY_URL` got when `/recuperar` went native.
 *
 * This constant used to carry a case AGAINST a native deletion: "there is no
 * `DELETE /api/v1/me` for a bearer token to call. Building one is real parity
 * work — a destructive, irreversible endpoint needs its own reason string, its
 * own audit action, its own rate limit and its own tests — and shipping a
 * thinner second definition of 'delete my account' beside the web's, in a hurry,
 * to satisfy a store checklist, is how the two drift."
 *
 * Every clause of that is still true and none of it argues for a link any more,
 * because the work it describes is what landed: `/api/v1/me/privacy` exists, and
 * it is emphatically NOT a second definition — both surfaces call the same
 * `eraseSubjectDataFor`, spend the same per-user budget, and are audited by the
 * same RPC. What the paragraph was really refusing was a HURRIED copy, and it
 * was right to.
 *
 * The prediction it made about the URL was wrong in one detail, which is worth
 * keeping: `DELETE /api/v1/me` serves the supresión and cannot serve the art. 14
 * export, so the endpoint is one path with two methods. See
 * `@dim/contract/api`'s `my-privacy.ts`.
 *
 * THE TWO COSTS IT ACCEPTED ARE PAID OFF. The person no longer re-authenticates
 * in a signed-out tab (the erasure takes the bearer token this app already
 * holds), and the app no longer fails to notice (the 200 is what drops the
 * session — `eraseAccount` in the session store). `AccountDeletionCard`'s copy
 * lost both warnings with them.
 *
 * WHAT IT IS STILL FOR, and it is not sentiment:
 *   1. THE DATA SAFETY FORM NAMES THIS URL. Play asks for a web address a
 *      reviewer can open without installing anything, and that requirement did
 *      not go away when the in-app route got better.
 *   2. IT IS THE ONLY WAY TO GET A REAL `.json` ONTO A DEVICE. The native screen
 *      SHOWS the export and hands it to the OS share sheet; writing a file needs
 *      `expo-file-system`, which is a native module, which is an EAS build. The
 *      web page downloads one. `PrivacyScreen` says so and offers this link
 *      underneath.
 * Delete the affordance on the day this app can write a file — and not before.
 *
 * ON THE ORIGIN. Derived from API_BASE_URL like TERMS_URL and PRIVACY_URL,
 * because in this deployment the API and the web app ARE one origin — the same
 * Next app serves `/api/v1/*` and `/cuenta/privacidad`. If they are ever split
 * (an API subdomain, a separate web host), every constant in this block breaks
 * the same way and with the same tell: the link opens a 404 on the API host
 * instead of the page. The fix then is a second env var
 * (`EXPO_PUBLIC_WEB_ORIGIN`) read through the same `envUrl` trim-then-fallback
 * rule, not a hardcoded hostname here — a pinned host is how a build points at
 * staging's API and production's deletion page.
 */
export const ACCOUNT_DELETION_URL = `${API_BASE_URL}/cuenta/privacidad`;

/**
 * The web URL where a forgotten password is reset.
 *
 * NO LONGER THE PRIMARY PATH, AND THE ARGUMENT THAT MADE IT ONE IS RECORDED
 * RATHER THAN DELETED. This constant used to carry a case AGAINST a native
 * recovery flow: "the reset round-trip is an emailed link that opens in a
 * BROWSER, so the native half would end at the same web page anyway, minus the
 * rate limiting and the account-state refusals that live there." WU-R-1 answered
 * both halves of it —
 *
 *   · the rate limiting is NOT lost: `POST /api/v1/auth/password-reset` is an
 *     adapter over the same use-case the web form calls, spending the same two
 *     buckets, so switching transport buys no fresh budget;
 *   · the round-trip is NOT only a link: the mail carries the recovery token as
 *     a six-digit CODE too, and a code comes back through the person's own eyes
 *     rather than through a browser — the one channel that works on a device
 *     with no verified App Links (apps/mobile/app.config.ts).
 *
 * — so `/recuperar` is now a NATIVE screen (`ROUTES.recuperar`) and this URL is
 * the secondary affordance on it.
 *
 * IT IS NOT DEAD WEIGHT WHILE IT SITS THERE. Supabase's default recovery
 * template renders the link and not `{{ .Token }}`, so until that template is
 * edited in the dashboard (PO-gated, exactly like "email confirmations ON" in
 * signup.ts) the link is the only half of the mail that arrives, and this is
 * where a real tester finishes. Delete the affordance on the day the template
 * lands — and not before.
 *
 * Unlike IDENTITY_COMPLETION_URL this one needs no warning about a lost session:
 * password recovery starts signed out by definition.
 */
export const PASSWORD_RECOVERY_URL = `${API_BASE_URL}/recuperar`;
