// Fitness test for `@dim/contract/links` — the deep-link table (T3.3).
//
// WHAT THIS PROTECTS
// ---------------------------------------------------------------------------
// A destination table is only worth having if every row in it actually resolves.
// A row naming a route that was renamed or deleted is WORSE than a template
// literal at the call site: the template literal is at least visible next to the
// page it points at, while a stale row is a promise made in a package that
// compiles perfectly and produces a 404 for whoever scanned the QR.
//
// So the table is checked against the file system router itself — the app/
// tree, which cannot lie about which routes exist — rather than against a second
// hand-maintained list, which could rot the same way.
//
// NON-VACUITY. Both sides carry a floor. A glob that stops matching produces an
// empty route set, an empty route set makes every check trivially unsatisfiable
// (or, if inverted, trivially satisfied), and this repo has been bitten by a
// fence whose corpus quietly missed its subject often enough to write the floor
// first and the check second.

import { globSync } from "node:fs";

import {
  APP_PATH_NAMES_NO_SCREEN,
  APP_SCHEME,
  DEEP_LINK_MAP,
  type DeepLinkAccess,
  type DeepLinkName,
  appRoutePath,
  deepLinkAppUrl,
  deepLinkPath,
  deepLinkUrl,
  matchWebPath,
  pathParamNames,
} from "@dim/contract/links";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// The route set, derived from app/
// ---------------------------------------------------------------------------

/** Floors. Both are far below the measurement (18 rows, 300+ routes). */
const MIN_MAP_ENTRIES = 15;
const MIN_DISCOVERED_ROUTES = 150;

/**
 * A pattern with its dynamic segments erased, so `/p/[publicToken]` from the
 * file system and `/p/:publicToken` from the table compare equal.
 *
 * Erasing rather than comparing names is deliberate: Next names the parameter
 * in the DIRECTORY, and several of those names disagree with the table's on
 * purpose (`/r/invite/[token]` vs `:invitationToken`, `/denuncias/codigo/[code]`
 * vs `:referenceCode`). The directory name is an implementation detail of one
 * page; the table's name is what a caller writes. What must match is the SHAPE.
 */
function eraseParams(pattern: string): string {
  return pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") || segment.startsWith("[") ? "*" : segment))
    .join("/");
}

/**
 * Every routable path in `app/`, as an erased pattern.
 *
 * Route groups `(app)` / `(public)` are removed — they organise layouts and
 * contribute nothing to the url. `_`-prefixed directories are Next's private
 * folders and are not routes at all. Catch-alls are skipped: nothing in the
 * table is a catch-all, and pretending `[...slug]` matches one erased segment
 * would let a stale row pass by accident.
 */
function discoverRoutes(): Set<string> {
  const files = [...globSync("app/**/page.tsx"), ...globSync("app/**/route.ts")].map((f) =>
    f.replaceAll("\\", "/"),
  );

  const routes = new Set<string>();
  for (const file of files) {
    if (file.includes("node_modules/")) continue;
    const withoutFile = file.replace(/^app/, "").replace(/\/(page\.tsx|route\.ts)$/, "");
    const segments = withoutFile.split("/").filter((s) => s !== "");
    if (segments.some((s) => s.startsWith("_") || s.startsWith("["))) {
      // `_private` folders are not routes; catch-alls are handled above.
      if (segments.some((s) => s.startsWith("_") || s.startsWith("[..."))) continue;
    }
    const visible = segments.filter((s) => !(s.startsWith("(") && s.endsWith(")")));
    routes.add(eraseParams(`/${visible.join("/")}`));
  }
  return routes;
}

// ---------------------------------------------------------------------------
// `access`, derived from the route group rather than believed (L2-4)
// ---------------------------------------------------------------------------

/**
 * What each Next route GROUP says about who can reach a page.
 *
 * `app/(public)/…` renders for a stranger with no cookie; `app/(app)/…` sits
 * behind the session guard and redirects to login. So the file system already
 * answers the question `access` claims to answer, and the label is checkable
 * instead of being taken on faith.
 *
 * WHY THIS EXISTS. `adoptionCatalogue` shipped labelled `session` while its page
 * says "Public landing — no auth required" in its first comment. Nothing caught
 * it, because the ONE rule that reads `access` — "never claims a public
 * destination" — keys off the hand-typed word: a row labelled `session` is
 * simply not looked at, so a mislabel does not break the fence, it switches the
 * fence off. A rule that a typo can disable is not a fence.
 */
const GROUP_ACCESS: Record<string, DeepLinkAccess> = {
  "(public)": "public",
  "(app)": "session",
};

/**
 * Every route shape in `app/`, mapped to the access its group implies.
 *
 * A shape reachable from BOTH groups is recorded as ambiguous (`null`) rather
 * than resolved by whichever file the glob returned first — `/denuncias` really
 * does exist under both, and picking one silently would be the same
 * hand-waving this derivation replaces.
 */
function discoverAccessByShape(): Map<string, DeepLinkAccess | null> {
  const files = [...globSync("app/**/page.tsx"), ...globSync("app/**/route.ts")].map((f) =>
    f.replaceAll("\\", "/"),
  );

  const byShape = new Map<string, DeepLinkAccess | null>();
  for (const file of files) {
    if (file.includes("node_modules/")) continue;
    const withoutFile = file.replace(/^app/, "").replace(/\/(page\.tsx|route\.ts)$/, "");
    const segments = withoutFile.split("/").filter((s) => s !== "");
    if (segments.some((s) => s.startsWith("_") || s.startsWith("[..."))) continue;
    const group = segments.find((s) => s.startsWith("(") && s.endsWith(")"));
    const access = group ? GROUP_ACCESS[group] : undefined;
    if (!access) continue;
    const shape = eraseParams(
      `/${segments.filter((s) => !(s.startsWith("(") && s.endsWith(")"))).join("/")}`,
    );
    const seen = byShape.get(shape);
    byShape.set(shape, seen === undefined || seen === access ? access : null);
  }
  return byShape;
}

/**
 * The rows whose page sits in NO route group, so the tree cannot answer.
 *
 * `app/libreta/compartir/[shareToken]` and `app/r/invite/[token]` are top-level
 * directories with their own layouts. Pinned as a LIST OF DECISIONS, the way
 * `APP_PATH_EXCEPTIONS` is: two rows still carry a hand-typed `access`, and
 * adding a third has to be a visible edit next to the reason rather than a
 * silent widening of what the derivation cannot see.
 */
const ACCESS_NOT_DERIVABLE: DeepLinkName[] = ["libretaShare", "orgInvitation"];

// ---------------------------------------------------------------------------
// The SECOND corpus, derived from apps/mobile/app/
// ---------------------------------------------------------------------------

/** Floor for the native screen set. Far below the measurement (14 screens). */
const MIN_APP_SCREENS = 8;

/**
 * The one destination whose `mimar://` form names no screen, with its reason.
 *
 * `appointment` is a QR PAYLOAD for a front-desk reader that does not exist yet
 * — see the entry's own comment. It is an exception rather than a reason to
 * weaken the rule, because the rule is what stops the next `appPath` from being
 * a link that opens the app onto nothing.
 *
 * IT USED TO BE DECLARED HERE and is now IMPORTED, because WU-Q-1 made it
 * load-bearing at runtime too: `appRoutePath` has to refuse this destination, and
 * a fence holding its own private copy of "the one exception" would agree with
 * the contract on the day it was written and not afterwards. The pinning test
 * below is unchanged and is what keeps the imported set honest.
 */
const APP_PATH_EXCEPTIONS = APP_PATH_NAMES_NO_SCREEN;

/**
 * Every screen in `apps/mobile/app/`, as an erased pattern.
 *
 * expo-router's file conventions, which differ from Next's in the three ways
 * that matter here: `index.tsx` IS its directory, `_layout.tsx` is not a route,
 * and `+`-prefixed files (`+not-found`) are the framework's own fallbacks rather
 * than addressable destinations.
 */
function discoverAppScreens(): Set<string> {
  const files = globSync("apps/mobile/app/**/*.tsx").map((f) => f.replaceAll("\\", "/"));

  const screens = new Set<string>();
  for (const file of files) {
    if (file.includes("node_modules/")) continue;
    const withoutRoot = file.replace(/^apps\/mobile\/app/, "").replace(/\.tsx$/, "");
    const segments = withoutRoot.split("/").filter((s) => s !== "");
    const last = segments.at(-1) ?? "";
    if (last === "_layout" || last.startsWith("+")) continue;
    // `index` names its parent directory, and the root `index` names "/".
    const visible = last === "index" ? segments.slice(0, -1) : segments;
    screens.add(eraseParams(`/${visible.join("/")}`));
  }
  return screens;
}

const ROUTES = discoverRoutes();
const APP_SCREENS = discoverAppScreens();
const NAMES = Object.keys(DEEP_LINK_MAP) as DeepLinkName[];

// ---------------------------------------------------------------------------

describe("the corpus is real", () => {
  it("discovers a plausible number of routes from app/", () => {
    expect(ROUTES.size).toBeGreaterThanOrEqual(MIN_DISCOVERED_ROUTES);
  });

  it("has a table with entries in it", () => {
    expect(NAMES.length).toBeGreaterThanOrEqual(MIN_MAP_ENTRIES);
  });

  // The corpus check that proves eraseParams() is doing its job rather than
  // mapping everything to the same string.
  it("recognises the credential route specifically", () => {
    expect(ROUTES.has("/p/*")).toBe(true);
    expect(ROUTES.has("/p/*/encontre")).toBe(true);
  });
});

describe("every destination resolves to a real route", () => {
  it.each(NAMES)("%s", (name) => {
    const erased = eraseParams(DEEP_LINK_MAP[name].webPath);
    expect(
      ROUTES.has(erased),
      [
        `deepLinkMap.${name} points at "${DEEP_LINK_MAP[name].webPath}", which matches no`,
        "page.tsx or route.ts under app/. Either the route moved and the table was not",
        "updated, or the table names a route that was never built.",
      ].join(" "),
    ).toBe(true);
  });
});

describe("the table is unambiguous", () => {
  it("has no two names pointing at the same path shape", () => {
    const byShape = new Map<string, DeepLinkName[]>();
    for (const name of NAMES) {
      const shape = eraseParams(DEEP_LINK_MAP[name].webPath);
      byShape.set(shape, [...(byShape.get(shape) ?? []), name]);
    }
    const collisions = [...byShape.entries()].filter(([, names]) => names.length > 1);
    expect(collisions, `collisions: ${JSON.stringify(collisions)}`).toEqual([]);
  });

  it("gives every path an absolute form", () => {
    for (const name of NAMES) {
      expect(DEEP_LINK_MAP[name].webPath.startsWith("/"), name).toBe(true);
      expect(DEEP_LINK_MAP[name].webPath.endsWith("/"), name).toBe(false);
    }
  });

  // A custom-scheme form that needed a parameter the web form does not have
  // could not be built from `DeepLinkParams<N>`, so this is a type hole the
  // compiler cannot see (the two strings are unrelated to it).
  it("never asks a mimar:// form for a parameter the web form lacks", () => {
    for (const name of NAMES) {
      const { webPath, appPath } = DEEP_LINK_MAP[name];
      if (appPath === null) continue;
      const webParams = new Set(pathParamNames(webPath));
      for (const param of pathParamNames(appPath)) {
        expect(webParams.has(param), `${name}: mimar:// form needs ":${param}"`).toBe(true);
      }
    }
  });

  // A `mimar://` form is a CLAIM THAT A SCREEN EXISTS, and the failure mode of a
  // false one is not an error: the app opens on a blank stack. So the claim is
  // checked against the native file-system router, which cannot lie about which
  // screens are there — the same reasoning that checks `webPath` against `app/`.
  //
  // THIS REPLACED A COUNT. The rule used to be `expect(withAppPath).toEqual
  // (["appointment"])`, written when the app had no screens worth naming and the
  // honest position was "the custom scheme resolves for nobody". That is no
  // longer true, and a frozen list would have made the fence fight the app
  // instead of checking it. What the old rule was PROTECTING — that nobody
  // builds links resolving to nothing — is exactly what this one enforces, and
  // it enforces it against reality rather than against a number.
  it.each(NAMES.filter((n) => DEEP_LINK_MAP[n].appPath !== null))(
    "%s names a screen the app actually has",
    (name) => {
      const appPath = DEEP_LINK_MAP[name].appPath as string;
      if (APP_PATH_EXCEPTIONS.has(name)) return;
      expect(
        APP_SCREENS.has(eraseParams(`/${appPath}`)),
        [
          `deepLinkMap.${name}.appPath is "${appPath}", which matches no screen under`,
          "apps/mobile/app/. A mimar:// url for it opens the app on a blank stack —",
          "custom schemes fail silently. Either add the screen, or set appPath to null.",
        ].join(" "),
      ).toBe(true);
    },
  );

  // The exception list is a list of DECISIONS, not a place to park failures, so
  // it is pinned. Growing it is a visible edit next to the reason.
  it("has exactly one destination claiming a screen that does not exist", () => {
    expect([...APP_PATH_EXCEPTIONS]).toEqual(["appointment"]);
    // …and it is the QR payload for a reader that does not exist yet. Kept
    // byte-for-byte because changing the string would break whatever eventually
    // reads it. See the entry's own comment.
    expect(DEEP_LINK_MAP.appointment.appPath).toBe("appointment/:appointmentToken");
  });

  // Non-vacuity for the second corpus. A glob that stops matching would make
  // every claim above trivially unsatisfiable, and the `.each` would go red —
  // but the EXCEPTION test would still pass, so the floor is what proves the
  // screen set is real.
  it("discovers the app's screens", () => {
    expect(APP_SCREENS.size).toBeGreaterThanOrEqual(MIN_APP_SCREENS);
    expect(APP_SCREENS.has("/mascotas/*")).toBe(true);
    expect(APP_SCREENS.has("/transferencias/*")).toBe(true);
  });

  // A public link HANDED TO SOMEBODY stays null, forever. A stranger's phone
  // camera does not follow `mimar://`, and a public link that only resolves for
  // people with the app installed is a lost pet nobody can report.
  //
  // THE RULE IS ABOUT PLACEHOLDERS, not about the word `public` alone (L2-4).
  // Every public destination that names ONE subject — a credential, a tag, a
  // case code, a share token — carries a `:param`, and that is precisely the
  // link somebody is given: on a collar, in an e-mail, on a poster. A
  // parameterless public page is a SECTION of the product, and the native inbox
  // pushing it opens a screen for somebody who already has the app. Stating the
  // rule as "public ⇒ null" would have forced `adoptionCatalogue` — public, no
  // placeholder — back to a dead CTA the moment its label was corrected.
  it("never claims a public destination that names ONE subject", () => {
    for (const name of NAMES) {
      const { access, webPath, appPath } = DEEP_LINK_MAP[name];
      if (access !== "public") continue;
      if (pathParamNames(webPath).length === 0) continue;
      expect(appPath, `${name} is a public link about one subject: no mimar:// form`).toBe(null);
    }
  });

  // NON-VACUITY for the rule above: it must still be looking at the rows it was
  // written for. Nine public destinations carry a placeholder today.
  it("still has public one-subject links to check", () => {
    const guarded = NAMES.filter(
      (n) =>
        DEEP_LINK_MAP[n].access === "public" && pathParamNames(DEEP_LINK_MAP[n].webPath).length > 0,
    );
    expect(guarded.length).toBeGreaterThanOrEqual(6);
    expect(guarded).toContain("credential");
    expect(guarded).toContain("tag");
  });

  // L2-4 — the label is DERIVED and compared, not believed. See GROUP_ACCESS.
  it("labels every destination with the access its route group implies", () => {
    const derived = discoverAccessByShape();
    const mismatches: string[] = [];
    const undecidable: DeepLinkName[] = [];

    for (const name of NAMES) {
      const fromTree = derived.get(eraseParams(DEEP_LINK_MAP[name].webPath));
      if (fromTree === undefined || fromTree === null) {
        undecidable.push(name);
        continue;
      }
      if (fromTree !== DEEP_LINK_MAP[name].access) {
        mismatches.push(
          `${name}: the table says "${DEEP_LINK_MAP[name].access}", app/ says "${fromTree}"`,
        );
      }
    }

    expect(
      mismatches,
      "a hand-typed access label disagrees with the route group its page lives in — " +
        "and the public-destination rule keys off that label, so the wrong word turns it off",
    ).toEqual([]);
    // The exception list is pinned: a row the tree cannot decide keeps a
    // hand-typed label, and there may be no more of those than were argued for.
    expect([...undecidable].sort()).toEqual([...ACCESS_NOT_DERIVABLE].sort());
    // NON-VACUITY: the derivation decided most of the table, rather than
    // answering "undecidable" for everything and passing.
    expect(NAMES.length - undecidable.length).toBeGreaterThanOrEqual(MIN_MAP_ENTRIES - 2);
  });
});

describe("deepLinkPath", () => {
  it("fills the placeholders", () => {
    expect(deepLinkPath("credential", { publicToken: "DIM-PAMP-0001" })).toBe("/p/DIM-PAMP-0001");
    expect(deepLinkPath("credentialFinder", { publicToken: "DIM-PAMP-0001" })).toBe(
      "/p/DIM-PAMP-0001/encontre",
    );
  });

  it("returns a parameterless path unchanged", () => {
    expect(deepLinkPath("myPets", {})).toBe("/mis-mascotas");
  });

  it("encodes a value that would otherwise change the path shape", () => {
    expect(deepLinkPath("welfareReport", { referenceCode: "a/b" })).toBe("/denuncias/codigo/a%2Fb");
  });

  // The failure this guards is a poster with "/p/undefined" printed on it.
  it("refuses a missing or empty value instead of printing it", () => {
    // @ts-expect-error — the compiler already refuses this; the throw is for
    // the caller who reached the builder with data from a database column.
    expect(() => deepLinkPath("credential", {})).toThrow(/missing value for ":publicToken"/);
    expect(() => deepLinkPath("credential", { publicToken: "" })).toThrow(/missing value/);
  });
});

describe("deepLinkUrl", () => {
  it("prefixes the origin", () => {
    expect(
      deepLinkUrl("https://www.mimar.com.ar", "credential", { publicToken: "DIM-PAMP-0001" }),
    ).toBe("https://www.mimar.com.ar/p/DIM-PAMP-0001");
  });

  it("tolerates a trailing slash on the origin", () => {
    expect(deepLinkUrl("https://www.mimar.com.ar/", "credential", { publicToken: "X" })).toBe(
      "https://www.mimar.com.ar/p/X",
    );
  });
});

describe("deepLinkAppUrl", () => {
  // BYTE-FOR-BYTE what app/(app)/mis-turnos/[appointmentToken]/page.tsx encoded
  // into its check-in QR before the migration. Keeping the custom scheme working
  // is explicit scope: replacing it with an https url would claim a verified App
  // Link that has no Play-signed fingerprint behind it.
  it("builds the check-in QR payload unchanged", () => {
    expect(deepLinkAppUrl("appointment", { appointmentToken: "APT-123" })).toBe(
      "mimar://appointment/APT-123",
    );
    expect(APP_SCHEME).toBe("mimar");
  });

  it("refuses a destination the app does not claim", () => {
    expect(() => deepLinkAppUrl("credential", { publicToken: "DIM-PAMP-0001" })).toThrow(
      /no mimar:\/\/ form/,
    );
  });
});

// ---------------------------------------------------------------------------
// The reverse direction (WU-Q-1) — a stored web path, matched back to a name
// ---------------------------------------------------------------------------

describe("matchWebPath — no two destinations can claim the same path", () => {
  // THE ASSUMPTION `matchWebPath` IS BUILT ON, checked rather than asserted in a
  // comment. It returns the FIRST pattern that matches, which is only a
  // well-defined answer if at most one ever can. Two rows with the same segment
  // count are distinguishable when there is at least one position where BOTH are
  // literals and the literals differ; if no such position exists, some concrete
  // path matches both and "first wins" silently decides which screen a
  // notification opens.
  // THE AMBIGUITY CHECK AND THE RANKING RULE LIVE IN THE PACKAGE.
  //
  // Both need `outranksWebPath`, which is internal to `deep-link-map.ts`.
  // Exporting it from `links/index.ts` so this file could import it moves the
  // native fingerprint — app.config.ts imports that barrel, so expo-updates
  // counts its file tree as a native config dependency, and one export line
  // published an OTA no installed phone could reach (measured 2026-09-07).
  // Importing it by path is refused by scripts/check-contract-purity.ts, which
  // is also right: that bypasses the exports map. So the unit test of an
  // internal rule sits next to the rule, in
  // packages/contract/src/links/deep-link-map.test.ts, inside the root vitest
  // walk. What stays here is everything observable through `matchWebPath`.

  it("resolves a STATIC sibling before the parameterised route it sits under", () => {
    // A5-ciudadanas-03, and the reason `matchWebPath` stopped returning the first
    // match. `/mis-mascotas/postulaciones` also satisfies
    // `/mis-mascotas/:publicToken`; under "first wins" it opened a credential for
    // a pet whose token is the word "postulaciones".
    expect(matchWebPath("/mis-mascotas/postulaciones")).toEqual({
      name: "myAdoptionApplications",
      params: {},
    });
    // NON-VACUITY: the parameterised route still works for a real token.
    expect(matchWebPath("/mis-mascotas/DIM-PAMP-0001")).toEqual({
      name: "pet",
      params: { publicToken: "DIM-PAMP-0001" },
    });
  });

  it("resolves the three CTA paths the inbox used to render as dead text", () => {
    // Six notification writers emit these literals (`cancel-appointment-by-org`,
    // `review-adoption-application` ×2, `finalize-adoption`, `death-record-use-case`,
    // `withdraw-rehome-sponsorship`, `adoption/actions`). With no row each came
    // back `{ label, route: null }`, which the inbox renders as greyed,
    // unpressable text TalkBack does not announce as a control at all — while the
    // app has had all three screens.
    expect(matchWebPath("/mis-turnos")?.name).toBe("myAppointments");
    expect(matchWebPath("/mis-mascotas/postulaciones")?.name).toBe("myAdoptionApplications");
    expect(matchWebPath("/adoptar")?.name).toBe("adoptionCatalogue");

    // And the app really has a screen for each — `appRoutePath` is the half the
    // inbox pushes, and it is null for a destination the app does not claim.
    expect(appRoutePath("myAppointments", {})).toBe("/turnos");
    expect(appRoutePath("myAdoptionApplications", {})).toBe("/adoptar/postulaciones");
    expect(appRoutePath("adoptionCatalogue", {})).toBe("/adoptar");
  });

  it("keeps ONE pet's listing distinct from the catalogue", () => {
    // `adoptionListing` is public and takes a token; `adoptionCatalogue` is the
    // signed-in list. Different segment counts, so no ambiguity — asserted
    // because the two names are one word apart.
    expect(matchWebPath("/adoptar/DIM-PAMP-0001")?.name).toBe("adoptionListing");
    expect(matchWebPath("/adoptar")?.name).toBe("adoptionCatalogue");
  });

  it("matches a concrete path back to its destination and values", () => {
    expect(matchWebPath("/mis-mascotas/DIM-PAMP-0001")).toEqual({
      name: "pet",
      params: { publicToken: "DIM-PAMP-0001" },
    });
    expect(matchWebPath("/mis-mascotas/DIM-PAMP-0001/eventos/abc-123")).toEqual({
      name: "petEvent",
      params: { publicToken: "DIM-PAMP-0001", eventId: "abc-123" },
    });
    // A no-placeholder row still resolves — several notifications land on the list.
    expect(matchWebPath("/mis-mascotas")).toEqual({ name: "myPets", params: {} });
  });

  it("decodes a percent-encoded segment", () => {
    expect(matchWebPath("/denuncias/codigo/AB%2F12")).toEqual({
      name: "welfareReport",
      params: { referenceCode: "AB/12" },
    });
  });

  it("answers null for a segment that will not decode, instead of throwing", () => {
    // THE FAILURE THIS PINS IS TOTAL, NOT ROW-LOCAL. `matchWebPath` is called
    // from `ctaOf` inside `buildMyNotificationV1`, which runs while the inbox
    // payload is being assembled — outside the try/catch in
    // `app/api/v1/me/notifications/route.ts`. An unguarded `decodeURIComponent`
    // therefore answers 500 for the caller's WHOLE native inbox on one stored
    // `cta_url` with a stray `%`, while the web renders the same row's
    // `cta_url` as a plain href and never notices.
    //
    // Latent rather than live: every current writer interpolates a
    // server-generated token or a uuid. It is still new parsing of STORED,
    // writer-produced strings, which is the class this repo keeps paying for.
    //
    // Each of these throws URIError out of a bare decodeURIComponent, and each
    // sits in a `:param` position of a pattern whose SEGMENT COUNT matches — so
    // "the loop never reaches the decode" is not what makes them null.
    for (const poisoned of [
      "/casos/50%", // truncated escape at the end
      "/casos/%", // nothing but the escape character
      "/casos/%zz", // two non-hex digits
      "/casos/%E0%A4%A", // truncated multi-byte sequence
      "/casos/%C0%80", // overlong encoding of NUL
      "/casos/%ED%A0%80", // lone UTF-16 surrogate
      "/denuncias/codigo/AB%2", // the same, one pattern deeper
      "/mis-mascotas/DIM-PAMP-0001/eventos/%", // in the second placeholder of two
    ]) {
      expect(matchWebPath(poisoned)).toBe(null);
    }

    // NON-VACUITY, because every assertion above is `toBe(null)` and this table
    // answers null for most strings. The same paths with the escape completed
    // match, which is what proves the loop reached the decode and that only the
    // malformed input is being refused.
    expect(matchWebPath("/casos/50%25")).toEqual({
      name: "welfareCase",
      params: { publicCode: "50%" },
    });
    expect(matchWebPath("/denuncias/codigo/AB%2F12")).toEqual({
      name: "welfareReport",
      params: { referenceCode: "AB/12" },
    });
  });

  it("drops query and fragment without returning them", () => {
    expect(matchWebPath("/mis-mascotas/DIM-PAMP-0001?tab=libreta#top")).toEqual({
      name: "pet",
      params: { publicToken: "DIM-PAMP-0001" },
    });
  });

  it("answers null for anything the table does not name", () => {
    // Most of the web app, on purpose: this is not a route registry.
    expect(matchWebPath("/inicio")).toBe(null);
    expect(matchWebPath("/mis-mascotas/DIM-PAMP-0001/libreta")).toBe(null);
    // An empty segment is not a value.
    expect(matchWebPath("/mis-mascotas//eventos/x")).toBe(null);
  });

  it("refuses an absolute url instead of matching its path", () => {
    // `cta_url` also holds external https links. Matching an attacker-chosen
    // origin's PATH against this table would let a link that is not ours name
    // one of our screens.
    expect(matchWebPath("https://evil.example/mis-mascotas/DIM-PAMP-0001")).toBe(null);
    expect(matchWebPath("mis-mascotas/DIM-PAMP-0001")).toBe(null);
  });
});

describe("appRoutePath", () => {
  it("returns the app's own path, rooted", () => {
    // Rooted, and shorter than the web's: the native route is `mascotas/…`.
    expect(appRoutePath("pet", { publicToken: "DIM-PAMP-0001" })).toBe("/mascotas/DIM-PAMP-0001");
    expect(appRoutePath("petTransfer", { transferToken: "PTR-9" })).toBe("/transferencias/PTR-9");
  });

  it("answers null when the app has no screen for the destination", () => {
    // Two different reasons, one answer — see the function's docblock.
    expect(appRoutePath("credential", { publicToken: "DIM-PAMP-0001" })).toBe(null);
    expect(appRoutePath("appointment", { appointmentToken: "APT-123" })).toBe(null);
  });

  it("answers non-null for exactly the destinations the app can open", () => {
    // The `.each` above proves that a non-null `appPath` names a real screen.
    // This is the OTHER end of the same claim: that `appRoutePath` hands one back
    // for exactly those destinations and refuses every other — so a caller can
    // treat `null` as "do not send a phone here" without consulting the table.
    const resolve = appRoutePath as (
      name: DeepLinkName,
      params: Record<string, string>,
    ) => string | null;
    for (const name of NAMES) {
      const { appPath, webPath } = DEEP_LINK_MAP[name];
      const params = Object.fromEntries(pathParamNames(webPath).map((p) => [p, "x"]));
      const openable = appPath !== null && !APP_PATH_EXCEPTIONS.has(name);
      expect(resolve(name, params) === null, name).toBe(!openable);
    }
  });
});

// ---------------------------------------------------------------------------
// The barrel's export surface is part of the NATIVE fingerprint
// ---------------------------------------------------------------------------
//
// `apps/mobile/app.config.ts:167` imports ANDROID_PACKAGE_NAME and
// IOS_BUNDLE_IDENTIFIER from `@dim/contract/links`, so expo-updates counts this
// module's file tree as a native config dependency under the fingerprint
// runtime policy. Editing `links/index.ts` therefore moves the runtime version
// and an OTA published from that tree reaches NO installed phone — it is not a
// failure anyone sees, it is an update that silently applies to nobody.
//
// MEASURED 2026-09-07. Lote L2 added one export line here (`outranksWebPath`,
// for the fitness test above). The OTA carrying lotes 1b, 1c and L3+L5
// published under runtime 3bd89d34fccf9000c08a60942a636a0c1aaa5d5f while Play
// build 10 runs 160f6069f9791f2c3bda95ae3829fa1ea4c4d49f. Removing that single
// line brought `eas fingerprint:compare` back to an exact match. The two other
// diffs it reported that day — three chalk/ansi-styles files and
// `sentryDsn: {}` — were artefacts of running the compare WITHOUT the EAS
// production environment, and vanish under `eas env:exec production`.
//
// This fence does not compute a fingerprint (that needs EAS and a build id).
// It pins the surface, so a change here goes red and whoever made it has to
// decide, deliberately, that the next release is a BUILD and not an OTA.
describe("the links barrel is a native-fingerprint surface", () => {
  it("exports exactly the pinned set — adding one moves the OTA runtime", async () => {
    const barrel = await import("@dim/contract/links");
    expect(Object.keys(barrel).sort()).toEqual(
      [
        "ANDROID_PACKAGE_NAME",
        "APP_PATH_NAMES_NO_SCREEN",
        "APP_SCHEME",
        "DEEP_LINK_MAP",
        "IOS_BUNDLE_IDENTIFIER",
        "appRoutePath",
        "deepLinkAppUrl",
        "deepLinkPath",
        "deepLinkUrl",
        "matchWebPath",
        "pathParamNames",
      ].sort(),
    );
  });

  it("still names the two symbols app.config.ts actually reads", async () => {
    const barrel = await import("@dim/contract/links");
    expect(typeof barrel.ANDROID_PACKAGE_NAME).toBe("string");
    expect(typeof barrel.IOS_BUNDLE_IDENTIFIER).toBe("string");
  });
});
