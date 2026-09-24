// `deepLinkMap` — one table mapping a LOGICAL DESTINATION to the path that
// resolves it (native-readiness T3.3).
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// Every surface that has to send somebody somewhere was building the path by
// hand, in a template literal, at the point of use. That is fine while there is
// exactly one consumer. There are now three, and they disagree about what a
// path even IS:
//
//   • the web app renders `<Link href={`/p/${token}`}>` — a path, no origin;
//   • a QR, a share sheet and an e-mail need an ABSOLUTE url, so the origin has
//     to come from somewhere (`window.location.origin`, `NEXT_PUBLIC_SITE_URL`,
//     `EXPO_PUBLIC_API_BASE_URL`) and each site picked its own;
//   • the check-in QR at `/mis-turnos/{token}` encodes `mimar://appointment/…`,
//     a CUSTOM SCHEME whose path shape (`appointment/…`) matches no web route
//     at all — and nothing anywhere recorded that the two forms of the same
//     destination had drifted apart.
//
// A fourth consumer is coming and is the reason this is a package and not a
// `lib/` module: the native router. When the phone receives a link it has to
// decide which screen it names, and it must make that decision from the SAME
// table the web app builds its urls from, or the two answer differently for the
// same string — which on a lost-pet QR means the scanner lands nowhere.
//
// WHAT IT IS NOT
// ---------------------------------------------------------------------------
// It is NOT a route registry, and it deliberately does not list every page in
// the app. A destination belongs here when something OUTSIDE the rendering
// surface has to name it: a QR, a notification CTA, an invitation e-mail, a
// share sheet, the native router. Internal navigation between two pages of the
// web app is `<Link href="…">` and should stay that way — putting 400 routes in
// this table would make it a second, worse copy of the file system router.
//
// It also does not know an origin. `deepLinkPath` returns a path; the caller
// that needs an absolute url passes its own origin to `deepLinkUrl`, because
// which origin is correct is a question only the caller can answer (the browser
// knows `window.location.origin`; a server render knows `NEXT_PUBLIC_SITE_URL`;
// the phone knows which backend its build points at).
//
// ZERO RUNTIME DEPENDENCIES, and it stays that way: this module is plain string
// work. See scripts/check-contract-purity.ts.

/**
 * The app's custom URL scheme, declared in `apps/mobile/app.json`.
 *
 * It resolves ONLY on a device that has the app installed, because the app
 * claims it by installing — no coordination with anyone, and no verification
 * either: any app could have claimed it. That is exactly why almost nothing
 * uses it (see `appPath` below).
 */
export const APP_SCHEME = "mimar";

/**
 * The Android application id and the iOS bundle identifier.
 *
 * These live HERE, next to the scheme, because they are not private to the
 * mobile app: they are how the app is NAMED in the link-claiming handshake, and
 * the other half of that handshake is served by the web app.
 * `/.well-known/assetlinks.json` publishes `package_name` — get it wrong by one
 * character and Android's verifier rejects the association silently, leaving
 * every link opening in Chrome with no error anywhere. Two copies of a string
 * that must agree, in two programs that never import each other, is exactly the
 * drift `packages/contract` exists to make impossible.
 *
 * `apps/mobile/app.config.ts` sets `android.package` / `ios.bundleIdentifier`
 * from these, so the Expo build and the well-known file cannot disagree.
 */
export const ANDROID_PACKAGE_NAME = "ar.mimar.app";
export const IOS_BUNDLE_IDENTIFIER = "ar.mimar.app";

/** Who can reach the destination once they hold the link. */
export type DeepLinkAccess =
  /** Anyone holding the link. The token IS the credential. */
  | "public"
  /** Requires a signed-in session; the page redirects to login otherwise. */
  | "session";

export type DeepLinkDestination = {
  /**
   * The web path, with `:name` placeholders. This is the canonical form: it is
   * what a QR encodes, what an e-mail links to, and what verified App Links
   * will hand the native router once they exist.
   */
  readonly webPath: string;
  /**
   * The path AFTER `mimar://`, or `null` when the app does not claim this
   * destination — which is still most of them, on purpose.
   *
   * A NON-NULL VALUE IS A CLAIM THAT A SCREEN EXISTS, and `__tests__/deep-link-
   * map.test.ts` checks it against `apps/mobile/app/` — the file-system router,
   * which cannot lie about which screens are there. That check is the whole
   * reason this field is worth filling: a `mimar://` url that resolves to
   * nothing does not error, it opens the app on a blank stack, which is the
   * failure mode custom schemes are notorious for.
   *
   * IT IS NOT THE WEB PATH WITH A DIFFERENT SCHEME. The app's own routes are
   * shorter in places (`mascotas/…` against the web's `/mis-mascotas/…`), so the
   * two halves of one destination genuinely differ and this table is where that
   * difference is recorded instead of being rediscovered.
   *
   * A custom scheme still cannot be the canonical form of anything a stranger
   * might scan: no phone camera follows `mimar://…` from a QR it finds in the
   * street, and it must not. That is why every public destination that is HANDED
   * TO SOMEBODY below is `null` and will stay `null` — a credential, a tag, a
   * case code, a share token. Each of those is a link given to one person about
   * one subject, which is exactly what a placeholder in the path means, so the
   * fitness test states the rule that way (L2-4): PUBLIC + a `:param` ⇒ no
   * `mimar://` form. A public page with no placeholder is a SECTION, not a link
   * — the app's own inbox pushes it for somebody who already has the app open.
   * When verified App Links land (blocked on a Play-signed fingerprint — see
   * apps/mobile/app.config.ts) these paths become the router's mapping from the
   * `https` form, and this table is what stops the two from drifting.
   */
  readonly appPath: string | null;
  readonly access: DeepLinkAccess;
};

/**
 * The table.
 *
 * Keys are LOGICAL names, not paths — that is the whole point. `/casos/:code`
 * can move to `/expedientes/:code` and every caller keeps compiling; a caller
 * that had hard-coded the string would not, and would not have been found
 * either, because `/casos/` appears in prose and in tests too.
 */
export const DEEP_LINK_MAP = {
  // -------------------------------------------------------------------------
  // Public — the pet IS the credential (invariant #1). Everything here resolves
  // for a stranger with a phone camera and no MiMAR install.
  // -------------------------------------------------------------------------

  /** The QR-verifiable public credential. The most important link in the product. */
  credential: { webPath: "/p/:publicToken", appPath: null, access: "public" },

  /** "I have this animal" — the finder-in-possession flow. */
  credentialFinder: { webPath: "/p/:publicToken/encontre", appPath: null, access: "public" },

  /** "I saw this animal" — the sighting report. */
  credentialSighting: { webPath: "/p/:publicToken/sighting", appPath: null, access: "public" },

  /** A physical tag's serial, which redirects to that pet's credential. */
  tag: { webPath: "/t/:serial", appPath: null, access: "public" },

  /** A pet published for adoption. */
  adoptionListing: { webPath: "/adoptar/:petToken", appPath: null, access: "public" },

  /** An organization's public profile. */
  shelter: { webPath: "/refugios/:orgToken", appPath: null, access: "public" },

  /** A welfare case by its public code — the citizen-facing view. */
  welfareCase: { webPath: "/casos/:publicCode", appPath: null, access: "public" },

  /** A welfare report tracked by the reference code handed to the reporter. */
  welfareReport: { webPath: "/denuncias/codigo/:referenceCode", appPath: null, access: "public" },

  /** A revocable share of a pet's health record. */
  libretaShare: { webPath: "/libreta/compartir/:shareToken", appPath: null, access: "public" },

  // -------------------------------------------------------------------------
  // Session — a notification CTA or an invitation lands here, and the page
  // sends the caller to login first when there is no session.
  // -------------------------------------------------------------------------

  /**
   * The owner's view of one of their pets.
   *
   * THE APP'S PATH IS SHORTER, and the difference is not cosmetic: the native
   * route is `mascotas/…` because in an app that only ever shows you your own
   * animals, "mis" is a word the URL does not need. The web says `/mis-mascotas`
   * because it also has `/p/…` and `/org/…/mascotas/…` to distinguish it from.
   */
  pet: {
    webPath: "/mis-mascotas/:publicToken",
    appPath: "mascotas/:publicToken",
    access: "session",
  },

  /** The owner's pet list — where several notifications land when no one pet is the subject. */
  myPets: { webPath: "/mis-mascotas", appPath: "mascotas", access: "session" },

  /**
   * ONE ASIENTO of one animal's libreta.
   *
   * IT EARNS A ROW because something outside names it: the vaccination-due and
   * correction notifications link to `/mis-mascotas/{token}/eventos/{id}`. That
   * is the bar this table sets in its own header, and it is why the LIBRETA and
   * the LOST-MODE cockpit are NOT here even though the app has screens for both
   * — nothing outside either surface names them, and a row for every screen the
   * app happens to have would make this a second, worse copy of two routers.
   */
  petEvent: {
    webPath: "/mis-mascotas/:publicToken/eventos/:eventId",
    appPath: "mascotas/:publicToken/eventos/:eventId",
    access: "session",
  },

  /**
   * One appointment, and THE ONE ENTRY WITH A CUSTOM-SCHEME FORM.
   *
   * The page renders a check-in QR encoding `mimar://appointment/{token}`. It
   * is a placeholder for a front-desk scan that has no reader yet, and it is
   * kept working verbatim: changing it to an `https` url today would be a claim
   * that the installed app opens it, which needs a verified App Link, which
   * needs a Play-signed fingerprint that does not exist (apps/mobile/app.config.ts).
   *
   * Note that `appPath` is NOT `mis-turnos/:appointmentToken`. The two forms of
   * this destination really did drift, in two files that never met. Recording
   * the drift here is the first step to closing it.
   *
   * IT NAMED NO SCREEN UNTIL F-8. `apps/mobile/app/appointment/[appointmentToken]
   * .tsx` now resolves it — NOT to the turno's own detail screen
   * (`/turnos/{token}`, which still refuses this path on purpose, see
   * `ui/routes.ts`'s `turnoRoute`), but to a generic, session-free "this code is
   * for the front desk" screen. That closes the narrow real gap (a phone
   * following the link landed on `+not-found`) without closing the wider debt
   * this comment still names: there is still no reader that DOES anything with
   * the token, because the one that would is a front-desk device that does not
   * exist yet. `APP_PATH_NAMES_NO_SCREEN` is empty today for exactly that
   * reason — the claim "a screen exists" is true again, the claim "a reader
   * exists" still is not, and only the first one is this table's job to check.
   */
  appointment: {
    webPath: "/mis-turnos/:appointmentToken",
    appPath: "appointment/:appointmentToken",
    access: "session",
  },

  /**
   * A caretaker invitation — the `/cuidado/{token}` key handed to the invitee.
   *
   * THE APP PATH IS THE WEB PATH, deliberately, as `petTransfer`'s is: the
   * invitation e-mail and the notification CTA both name `/cuidado/{token}`, and
   * keeping the two identical means the `mimar://` form and the `https` form
   * differ only in scheme — one less place for a destination to drift.
   *
   * Claimed in WU-P, in the commit AFTER the screen landed, so the fitness test
   * had something to resolve to at every point in the history.
   */
  caretakerGrant: {
    webPath: "/cuidado/:grantToken",
    appPath: "cuidado/:grantToken",
    access: "session",
  },

  /** An invitation to join an organization. */
  orgInvitation: { webPath: "/r/invite/:invitationToken", appPath: null, access: "session" },

  /**
   * A pending ownership transfer — THE DEEP-LINK-HEAVY ONE.
   *
   * Two notifications point here (`pet_transfer_received` to the addressee,
   * `pet_transfer_initiated` to the sender), and the invitation e-mail sent to
   * an address with no account yet lands here too. It is therefore the
   * destination most likely to be opened by somebody who did not navigate to it,
   * and the reason the app's path is kept IDENTICAL to the web's: the two forms
   * differ only in scheme, which is one less place for them to drift.
   */
  petTransfer: {
    webPath: "/transferencias/:transferToken",
    appPath: "transferencias/:transferToken",
    access: "session",
  },

  /**
   * A foster-care proposal awaiting the fosterer's answer.
   *
   * `appPath` NAMES THE HUB, NOT ONE PROPOSAL, unlike `petTransfer` above.
   * The app folds the web's three tránsito pages (propuestas, activos,
   * historial) into one screen (`GET /api/v1/me/foster`), which has no
   * per-token route to land a `:proposalToken` param on. Opening the hub is
   * enough: the person finds the one proposal a notification named in the
   * "Propuestas" section, exactly as `/cuenta/transitos` would list it. Its
   * dropped param is legal — the fitness test only requires an `appPath`'s
   * own placeholders to be a subset of `webPath`'s, never the whole set.
   */
  fosterProposal: {
    webPath: "/cuenta/transitos/propuestas/:proposalToken",
    appPath: "cuenta/transito",
    access: "session",
  },

  /** The inbox of invitations and requests addressed to the signed-in person. */
  accountRequests: { webPath: "/cuenta/solicitudes", appPath: null, access: "session" },

  // -------------------------------------------------------------------------
  // A5-ciudadanas-03 — three destinations the app HAS and this table did not.
  //
  // The bar this table's header sets is "something outside names it", and all
  // three clear it by a wide margin: they are `cta_url` literals in six
  // notification writers (`cancel-appointment-by-org.ts`,
  // `review-adoption-application.ts` twice, `finalize-adoption.ts`,
  // `death-record-use-case.ts`, `withdraw-rehome-sponsorship.ts` and
  // `adoption/actions.ts`). With no row, `matchWebPath` returned null and
  // `ctaOf` produced `{ label, route: null }` — which the inbox renders as
  // greyed, unpressable text that TalkBack does not even announce as a control.
  // A clinic cancels a turno and the person is shown a dead "Ver mis turnos"
  // while the app has had `app/turnos/index.tsx` all along.
  // -------------------------------------------------------------------------

  /** The person's own appointments. Cancelled-by-the-clinic notifications land here. */
  myAppointments: { webPath: "/mis-turnos", appPath: "turnos", access: "session" },

  /**
   * The applications this person has sent to shelters.
   *
   * THE TWO PATHS DIVERGE, like `pet`/`myPets` above and for the same reason:
   * the web hangs it off `/mis-mascotas` (it also has `/org/…` and `/adoptar/…`
   * to distinguish it from), and the app files it under the adoption section
   * because that is where a person looks for it — `app/adoptar/postulaciones.tsx`.
   */
  myAdoptionApplications: {
    webPath: "/mis-mascotas/postulaciones",
    appPath: "adoptar/postulaciones",
    access: "session",
  },

  /**
   * The catalogue of animals published for adoption.
   *
   * SEPARATE FROM `adoptionListing`, which is ONE pet. Both are PUBLIC, and this
   * row said `session` until L2-4: the reasoning written here was about WHO the
   * notifications pointing at it are addressed to (a signed-in applicant), which
   * is not what the field means. `access` says whether the PAGE requires a
   * session, and `app/(public)/adoptar/page.tsx` says in its own first comment
   * "Public landing — no auth required".
   *
   * The mislabel was not cosmetic: the fitness rule "never claims a public
   * destination" keys off this word, so a wrong word silently switched the fence
   * off for this row. It is now DERIVED from the route group the page lives in
   * and compared against the label — see `__tests__/deep-link-map.test.ts`.
   *
   * IT KEEPS ITS `appPath`, and that is the narrowed rule rather than an
   * exception to it: what a public destination must never have is a `mimar://`
   * form of a link handed to a STRANGER — a credential, a tag, a case code, a
   * share token. Those all carry a placeholder, and every one of them is `null`.
   * This row has no placeholder: it is a section of the app the native inbox
   * pushes for a person who already has the app open, and blanking it would send
   * "mirá otras mascotas" back to being grey unpressable text.
   */
  adoptionCatalogue: { webPath: "/adoptar", appPath: "adoptar", access: "public" },

  /**
   * The web wizard for a disputa this app's own claim screen cannot run
   * (T4-M6, 2026-09-22). `claimDisputeUrl` (`apps/mobile/src/claims/
   * claim-view-model.ts`) used to interpolate `${origin}/mis-mascotas/reclamar`
   * by hand, the one function in that file that did not follow its own
   * neighbour's rule — `claimSightingUrl`, two functions above it, already went
   * through this table so "a rename is a compile error rather than a 404
   * nobody notices". A STATIC SIBLING of `pet` (`/mis-mascotas/:publicToken`),
   * same shape `myAdoptionApplications` already resolved: `outranksWebPath`
   * ranks the literal segment ahead of the placeholder at the position they
   * differ, so this never resolves to `pet` with `publicToken: "reclamar"`.
   */
  claimDispute: { webPath: "/mis-mascotas/reclamar", appPath: "reclamar", access: "session" },
} as const satisfies Record<string, DeepLinkDestination>;

export type DeepLinkName = keyof typeof DEEP_LINK_MAP;

/**
 * Destinations whose `appPath` names NO SCREEN in `apps/mobile/app/`.
 *
 * EMPTY TODAY. `appointment` was its one member until F-8 — see that entry's
 * comment for what closed and what is still open — and the fitness test's
 * `.each` (`__tests__/deep-link-map.test.ts`) now checks every `appPath`
 * against `apps/mobile/app/` with no exception to skip. This set is not
 * retired: a future `appPath` added as a placeholder ahead of its screen
 * belongs here, named with the same reasoning `appointment`'s entry carried.
 *
 * IT LIVES HERE RATHER THAN IN THE FITNESS TEST, where it used to, because it is
 * load-bearing at RUNTIME as well as in CI: `appRoutePath` refuses every name in
 * it, and a second copy of the exception list is exactly the kind of pair that
 * agrees on the day it is written and disagrees a year later.
 * `__tests__/deep-link-map.test.ts` still pins the contents.
 */
export const APP_PATH_NAMES_NO_SCREEN: ReadonlySet<DeepLinkName> = new Set([]);

/**
 * The `:name` placeholders of a path pattern, as a union of string literals.
 *
 * This is what makes the table worth using instead of a template literal: pass
 * `{ token }` where the pattern says `:publicToken` and it is a COMPILE error,
 * in both programs, rather than a url with a literal `:publicToken` in it.
 */
type PathParams<S extends string> = S extends `${string}:${infer Param}/${infer Rest}`
  ? Param | PathParams<`/${Rest}`>
  : S extends `${string}:${infer Param}`
    ? Param
    : never;

/** The arguments a destination needs. `{}` for the ones with no placeholders. */
export type DeepLinkParams<N extends DeepLinkName> = Record<
  PathParams<(typeof DEEP_LINK_MAP)[N]["webPath"]>,
  string
>;

/** The placeholder names of a pattern, at runtime — for fences and routers. */
export function pathParamNames(pattern: string): string[] {
  return pattern
    .split("/")
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => segment.slice(1));
}

function fillPattern(pattern: string, params: Record<string, string>, name: string): string {
  return pattern
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment;
      const key = segment.slice(1);
      const value = params[key];
      // A missing value must never become the string "undefined" in a url
      // somebody is about to print on a poster.
      if (value === undefined || value === "") {
        throw new Error(`deepLink("${name}"): missing value for ":${key}" in "${pattern}".`);
      }
      // Tokens are `[A-Z0-9-]` and encode to themselves, so this is a no-op for
      // the credential path. It is not a no-op for a welfare reference code or
      // anything else a human might one day be allowed to choose.
      return encodeURIComponent(value);
    })
    .join("/");
}

/**
 * The path for a destination — no origin, no scheme. What `<Link href>` takes.
 *
 *   deepLinkPath("credential", { publicToken })  // "/p/DIM-PAMP-0001"
 */
export function deepLinkPath<N extends DeepLinkName>(name: N, params: DeepLinkParams<N>): string {
  return fillPattern(DEEP_LINK_MAP[name].webPath, params as Record<string, string>, name);
}

/**
 * The absolute url for a destination. The CALLER supplies the origin, because
 * only the caller knows which one is right (see the header).
 *
 * A trailing slash on the origin is tolerated and removed — the empty-string
 * trap this repo has already paid for once is a DIFFERENT bug and belongs at
 * the site that reads the environment variable, not here.
 */
export function deepLinkUrl<N extends DeepLinkName>(
  origin: string,
  name: N,
  params: DeepLinkParams<N>,
): string {
  return `${origin.replace(/\/+$/, "")}${deepLinkPath(name, params)}`;
}

/**
 * The reverse direction: a CONCRETE web path, matched back to the destination it
 * names and the values its placeholders held.
 *
 * WHY IT EXISTS. `notifications.cta_url` stores a web path — the string the
 * browser's CTA button links to — and it is written by twenty-odd notification
 * writers that have never heard of a phone. The native inbox has to open the
 * thing a notification is ABOUT, and the only way to do that without a second
 * table mapping notification types to native screens is to read the path the web
 * already stores and ask this table what it names.
 *
 * A `:param` segment matches any non-empty segment and yields its DECODED value,
 * so `matchWebPath("/mis-mascotas/DIM-PAMP-0001")` answers
 * `{ name: "pet", params: { publicToken: "DIM-PAMP-0001" } }`.
 *
 * A SEGMENT THAT WILL NOT DECODE IS NOT A MATCH, and the reason is where this
 * function is CALLED from rather than anything about percent-encoding.
 * `decodeURIComponent` throws `URIError` on malformed input (`/casos/50%`), and
 * the caller is `ctaOf` inside `buildMyNotificationV1`, which runs while the
 * inbox payload is being built — OUTSIDE the route's try/catch. One stored
 * `cta_url` with a stray `%` in a `:param` position of a length-matching pattern
 * would therefore answer 500 for the caller's ENTIRE native inbox rather than
 * costing that one row its button. No writer can emit such a string today: every
 * one of them interpolates a server-generated token or a uuid. This is new
 * parsing of STORED, writer-produced strings all the same, and the posture the
 * sibling payload module states for its other two judgement calls — an
 * unrecognised category comes across as `null`, a redacted CTA comes across
 * absent — is that a bad row costs itself and nothing else. Refusing the match
 * is what makes that true here: the label still rides, `route` is `null`, and the
 * other ninety-nine rows render.
 *
 * `null` FOR ANYTHING THIS TABLE DOES NOT NAME, and that is most of the web app
 * on purpose (see the header: this is not a route registry). A caller must treat
 * `null` as "the app has no screen for this", never as "the link is broken".
 *
 * QUERY AND FRAGMENT ARE DROPPED before matching, and their values are NOT
 * returned. Nothing in this table takes a query parameter, and a caller that got
 * one back would be tempted to forward it into a native route that cannot read
 * it. An ABSOLUTE url is refused outright rather than parsed: `cta_url` also
 * holds external `https://` links (the card opens those in a browser tab), and
 * quietly matching an attacker-chosen origin's path against this table would let
 * a link that is not ours name one of our screens.
 *
 * TWO PATTERNS MAY MATCH ONE PATH, and which one wins is a RULE rather than key
 * order — that sentence replaces an "AMBIGUITY IS IMPOSSIBLE BY CONSTRUCTION"
 * claim that this table stopped satisfying the day `myAdoptionApplications`
 * landed (L2-6). It used to say that for every pair with the same segment count
 * there is a position where both are literals and the literals differ.
 * `/mis-mascotas/postulaciones` and `/mis-mascotas/:publicToken` have no such
 * position: any concrete path matching the first matches the second too.
 *
 * So `__tests__/deep-link-map.test.ts` proves the TWO-ARM rule the table
 * actually satisfies. A same-length pair is fine when it is either:
 *
 *   1. SEPARABLE — some position where both are literals and the literals
 *      differ. No concrete path matches both, so order never arises.
 *   2. RANKED — `outranksWebPath` decides, at the leftmost position where one
 *      pattern is a literal and the other a placeholder. That is the ROUTERS'
 *      own rule (see `outranksWebPath`), so the table answers what Next and
 *      expo-router answer for the same string.
 *
 * A pair that is NEITHER is a pair with the same literal/placeholder shape at
 * every position and no differing literal — which is the same erased shape, and
 * the "no two names pointing at the same path shape" test already refuses it.
 * That is why ambiguity is still impossible, and it is impossible for a reason
 * that survives the next static sibling being added. Do NOT restore "first
 * wins": under it this table opens a credential for a pet whose token is the
 * word "postulaciones".
 */
/**
 * `decodeURIComponent`, as a value rather than as a throw.
 *
 * The ONLY thing it catches is `URIError`, and it rethrows anything else. A
 * blanket `catch` here would swallow a future bug in this function and report it
 * as "that path names nothing", which is the quietest possible way to lose a
 * link.
 */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

/**
 * Whether `left` is the pattern a router would resolve FIRST for a concrete path
 * that matches both. Exported because the fitness test enforces the same rule
 * over the whole table, and a fence holding its own copy of a ranking rule
 * agrees with the runtime on the day it is written and not afterwards.
 *
 * POSITIONAL, LEFT TO RIGHT, and that is the correction L2-7 asked for. The
 * first version ranked by TOTAL literal count. The two rules agree for every
 * pair in this table today, which is exactly why the divergence would have
 * shipped unnoticed: `/casos/nuevo/:x/:y` (3 literals) against
 * `/casos/:code/anexos/:n` (3 literals) is a tie the old fence caught, but
 * `/a/b/:q/:r` (3) against `/a/:p/c/d` (4) is not — different totals, so the
 * fence stayed quiet, while the routers resolve the FIRST one for `/a/b/c/d`
 * because its literal sits further left. Counting says the second. A table that
 * answers differently from the router it mirrors sends a notification to a
 * screen the web would never have opened.
 *
 * Next resolves `app/(app)/mis-mascotas/postulaciones/page.tsx` before
 * `app/(app)/mis-mascotas/[publicToken]/page.tsx`, and expo-router does the same
 * for `app/adoptar/postulaciones.tsx` against `app/adoptar/[petToken].tsx` — a
 * static segment beating a placeholder at the earliest position they differ.
 *
 * `false` for a tie: every position agrees on literal-vs-placeholder. Callers
 * keep whatever they already had, which for two patterns of the same shape is
 * the earlier row — and the fitness test refuses that pair anyway.
 */
export function outranksWebPath(left: string, right: string): boolean {
  const leftSegments = left.split("/");
  const rightSegments = right.split("/");
  const length = Math.max(leftSegments.length, rightSegments.length);
  for (let index = 0; index < length; index += 1) {
    const leftSegment = leftSegments[index];
    const rightSegment = rightSegments[index];
    const leftLiteral = leftSegment !== undefined && !leftSegment.startsWith(":");
    const rightLiteral = rightSegment !== undefined && !rightSegment.startsWith(":");
    if (leftLiteral !== rightLiteral) return leftLiteral;
  }
  return false;
}

export function matchWebPath(
  path: string,
): { name: DeepLinkName; params: Record<string, string> } | null {
  if (!path.startsWith("/")) return null;
  const clean = path.split("#")[0]?.split("?")[0] ?? "";
  const segments = clean.split("/");

  // THE ROUTERS' RULE DECIDES, positionally — see `outranksWebPath`. It used to
  // return the first pattern that matched, and this table used to contain no
  // static sibling of a parameterised route, so the two agreed. Adding
  // `myAdoptionApplications` (`/mis-mascotas/postulaciones`) is the first pair
  // where they do not: under "first wins" the CTA resolved to `pet` with
  // `publicToken: "postulaciones"` and opened a credential that does not exist.
  // `claimDispute` (`/mis-mascotas/reclamar`, T4-M6) is the second such static
  // sibling, ranked the same way. `/mis-mascotas/nueva` is a third this table
  // does not carry yet and would hit the same edge if it ever does.
  let best: { name: DeepLinkName; params: Record<string, string>; webPath: string } | null = null;

  for (const name of Object.keys(DEEP_LINK_MAP) as DeepLinkName[]) {
    const webPath = DEEP_LINK_MAP[name].webPath;
    const pattern = webPath.split("/");
    if (pattern.length !== segments.length) continue;

    const params = matchPattern(pattern, segments);
    if (params === null) continue;
    // A tie keeps the earlier row — the old behaviour for the only case a tie
    // can arise in, which is two rows the fitness test already refuses as
    // indistinguishable.
    if (best === null || outranksWebPath(webPath, best.webPath)) best = { name, params, webPath };
  }
  return best === null ? null : { name: best.name, params: best.params };
}

/**
 * One pattern against one concrete path, as its captured params — or `null` when
 * it does not match. Split out of `matchWebPath` so the SELECTION rule above and
 * the MATCHING rule here are readable apart.
 */
function matchPattern(pattern: string[], segments: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (const [index, expected] of pattern.entries()) {
    const actual = segments[index] ?? "";
    if (!expected.startsWith(":")) {
      if (expected !== actual) return null;
      continue;
    }
    // An empty segment ("/mis-mascotas//eventos/x") is not a value.
    if (actual === "") return null;
    // Malformed percent-encoding is not a value either. See the docblock:
    // letting the URIError out would turn one bad stored row into a 500 for the
    // whole inbox, because this runs outside the route's try/catch.
    const decoded = decodeSegment(actual);
    if (decoded === null) return null;
    params[expected.slice(1)] = decoded;
  }
  return params;
}

/**
 * The IN-APP route for a destination — a path the native router can push — or
 * `null` when the app has no screen for it.
 *
 * It is `appPath` with a leading slash, which is not a cosmetic difference:
 * `appPath` is the part AFTER `mimar://`, and expo-router addresses its screens
 * from the root. Two callers building that slash by hand is one of them
 * forgetting it.
 *
 * NULL IN TWO CASES, and they mean the same thing to a caller: the destination
 * has no `mimar://` form at all (most of the table — every public one, forever),
 * or its `appPath` names no screen (`APP_PATH_NAMES_NO_SCREEN` — exactly one).
 * Both mean "do not send a phone here"; a caller that distinguished them would be
 * deciding to open a link that resolves to a blank stack.
 */
export function appRoutePath<N extends DeepLinkName>(
  name: N,
  params: DeepLinkParams<N>,
): string | null {
  const { appPath } = DEEP_LINK_MAP[name];
  if (appPath === null) return null;
  if (APP_PATH_NAMES_NO_SCREEN.has(name)) return null;
  return `/${fillPattern(appPath, params as Record<string, string>, name)}`;
}

/**
 * The `mimar://` url for the one destination that has a custom-scheme form.
 *
 * Throws for every other name, deliberately: inventing a scheme url for a
 * destination the app does not claim produces a link that silently opens
 * nothing, which is the failure mode custom schemes are notorious for.
 */
export function deepLinkAppUrl<N extends DeepLinkName>(name: N, params: DeepLinkParams<N>): string {
  const { appPath } = DEEP_LINK_MAP[name];
  if (appPath === null) {
    throw new Error(
      [
        `deepLinkAppUrl("${name}"): this destination has no ${APP_SCHEME}:// form.`,
        "Use deepLinkUrl() with an https origin — a custom scheme resolves only on a device",
        "that already has the app, and resolves to nothing everywhere else.",
      ].join(" "),
    );
  }
  return `${APP_SCHEME}://${fillPattern(appPath, params as Record<string, string>, name)}`;
}
