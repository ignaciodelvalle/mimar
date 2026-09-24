// GET /api/v1/pets/{publicToken}/credential — the first `/api/v1` endpoint.
//
// WHAT THIS FILE HAS TO PROVE, AND WHY EACH PART EXISTS
// ---------------------------------------------------------------------------
// The four-way union is already proved without a database in
// src/modules/pets/application/read/lookup-public-credential.test.ts. This file
// proves the things that are the ROUTE's own and that no other test can see:
//
//   1. The HTTP mapping (429 / 404 / 503 / 200) and the envelope §6 requires.
//   2. `cache-control: no-store` on EVERY branch. It is NOT inherited —
//      middleware stamps it from a path-prefix allowlist `/api/…` does not
//      match — so the only thing standing between this endpoint and the stale
//      "SE BUSCA + owner phone" class closed on 2026-07-07 is that every one of
//      four returns sets the header. A test that checks the happy path only
//      would have certified exactly the branch nobody forgets.
//   3. The per-lookup limiter runs BEFORE the door. A limiter placed after the
//      lookup bounds nothing, and the assertion is on ORDER, not presence.
//   4. THE ANTI-ORACLE PROPERTIES (§1.1 / §9 item 10), which are the reason this
//      surface gets a checklist at all. Three of them, each a real disclosure
//      someone could ship:
//        • a rate-limit response must not say whether the token exists;
//        • an ERASED subject's credential (PO-4 soft delete) must be
//          indistinguishable from a token that never existed;
//        • `not_found` and `throttled` must not differ in anything but the
//          status line and the error code.
//   5. The payload carries no internal id, no microchip number and nothing
//      DNI-shaped — measured against a REAL row, because the point is what the
//      projection does with data that exists, not what a fixture happened to
//      omit.
//
// HOW THE MOCKING WORKS, AND WHY IT IS A PASSTHROUGH
// ---------------------------------------------------------------------------
// Both mocks default to the REAL implementation and are switched to a stub only
// for the tests that need one. That is what lets the live-database cases in the
// last describe share a file with the mapped-status cases: a plain `vi.mock`
// factory would have replaced the door for the whole module graph, and the
// PO-4 erasure property can only be measured against Postgres.

import { randomUUID } from "node:crypto";

import { type MockInstance, afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  /** When set, replaces the door's answer. `null` = call the real one. */
  door: null as null | (() => unknown),
  /**
   * When set, replaces the limiter. `null` = call the real one.
   *
   * It may throw (a `RateLimitError` for "over the limit", anything else for
   * "the limiter itself is broken") or return a promise that never settles, so
   * the DB-budget arm can be exercised too.
   */
  rateLimit: null as null | ((endpoint: string, identifier: string) => void | Promise<void>),
  /** Every collaborator the handler reached, in order. */
  calls: [] as string[],
  /**
   * The CONFIG each limiter call carried, per bucket (B13).
   *
   * `calls` records that a bucket was consulted; it cannot record with WHICH
   * ceiling, and after B13 that is the interesting half. Delete `surfaceLimit:`
   * from the route and every ordering assertion above still passes while the
   * endpoint silently drops back to the four HTML surfaces' 60/min — the limit
   * that refuses a whole carrier gateway.
   */
  limits: [] as Array<{ endpoint: string; config: unknown }>,
}));

vi.mock("@/src/modules/pets/application/read/lookup-public-credential", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/src/modules/pets/application/read/lookup-public-credential")
    >();
  return {
    ...actual,
    lookupPublicCredential: async (
      ...args: Parameters<typeof actual.lookupPublicCredential>
    ): Promise<Awaited<ReturnType<typeof actual.lookupPublicCredential>>> => {
      control.calls.push("door");
      if (control.door) return control.door() as never;
      return actual.lookupPublicCredential(...args);
    },
  };
});

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: async (endpoint: string, identifier: string, config: never) => {
      control.calls.push(`limit:${endpoint}`);
      control.limits.push({ endpoint, config });
      if (control.rateLimit) {
        await control.rateLimit(endpoint, identifier);
        return;
      }
      return actual.enforceRateLimit(endpoint, identifier, config);
    },
  };
});

import { type Pet, db, petIdentifications, pets } from "@/db";
import { RateLimitError } from "@/lib/infra/rate-limit";
import type { CredentialViewData } from "@/src/modules/pets/application/read/load-public-credential";
import { inArray } from "drizzle-orm";

import {
  LOOKUP_BUCKET,
  PUBLIC_TOKEN_API_LOOKUP_LIMIT,
  PUBLIC_TOKEN_API_SURFACE_LIMIT,
} from "@/app/api/v1/pets/[publicToken]/credential/limits";
import {
  PUBLIC_CREDENTIAL_STALE_AFTER_MS,
  buildDegradedPublicCredentialV1,
  buildPublicCredentialV1,
} from "@/app/api/v1/pets/[publicToken]/credential/payload";
import { GET } from "@/app/api/v1/pets/[publicToken]/credential/route";
import { PUBLIC_TOKEN_READ_LIMIT, publicTokenThrottle } from "@/lib/infra/public-token-throttle";

/**
 * D1's surface bucket, spelled out rather than imported.
 *
 * `route.ts` writes it as a LITERAL at the call site because the throttle
 * coverage fence rejects a computed bucket, so there is no constant to import —
 * and exporting one to satisfy this test would defeat the fence it satisfies.
 */
const SURFACE_BUCKET = "public_token_api_credential";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// A fresh IP per RUN. The real limiter is a persistent DB counter with an
// hourly window, so a fixed address would accumulate across runs and start
// 429-ing the live cases on the fourth `pnpm test` of an afternoon — a failure
// that looks like a bug in the route and is not.
const CALLER_IP = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;

async function get(publicToken: string, ip: string = CALLER_IP) {
  return GET(
    new Request(`http://test.local/api/v1/pets/${encodeURIComponent(publicToken)}/credential`, {
      headers: { "x-real-ip": ip },
    }),
    { params: Promise.resolve({ publicToken }) },
  );
}

/** Status + every header + the parsed body — the whole observable response. */
async function observe(response: Response) {
  return {
    status: response.status,
    headers: Object.fromEntries([...response.headers.entries()].sort()),
    body: await response.json(),
  };
}

/** Only the limiter calls, in order — the door marker filtered out. */
function limiterCalls(): string[] {
  return control.calls.filter((c) => c.startsWith("limit:"));
}

/** reportError's sink is stderr, so its lines land here (see report-error.ts). */
let errorSpy: MockInstance<(...args: unknown[]) => void>;

/** Everything reportError wrote this test, as one searchable string. */
function reportedErrors(): string {
  return errorSpy.mock.calls.map((args) => args.map((a) => String(a)).join(" ")).join("\n");
}

beforeEach(() => {
  control.door = null;
  control.rateLimit = null;
  control.calls = [];
  control.limits = [];
  // The degraded branches log one structured line through reportError.
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// Fixtures for the mapped-status cases
// ---------------------------------------------------------------------------

const TOKEN = "DIM-APIV1-TEST";

const ACTIVE_PET = {
  id: "00000000-0000-0000-0000-0000000000aa",
  publicToken: TOKEN,
  name: "Pampa",
  species: "dog",
  breed: "Mestizo",
  sex: "female",
  color: "marrón",
  distinguishingFeatures: "collar rojo",
  dateOfBirth: "2020-01-01",
  deceasedAt: null,
  status: "active",
  primaryPhotoId: null,
  emergencyInfoVisible: false,
  inCustodyDispute: false,
  potentiallyDangerousBreed: false,
  rabiesObservationStatus: null,
  permanentConditions: [],
  permanentConditionsOther: null,
  discloseConditionsPublicly: false,
  tier2PublicPermanent: false,
  tier2PublicEnabledUntil: null,
  allowFinderFormWhenLost: true,
  discloseFirstNameWhenLost: false,
  disclosePhoneWhenLost: false,
  discloseEmailWhenLost: false,
  discloseLastLocationWhenLost: false,
  jurisdictionLocality: "Ushuaia",
} as unknown as Pet;

const VIEW_DATA = {
  canonicalIds: { microchip: null, tattoo: null },
  hasVaccinations: false,
  latestVaccinationRows: [],
  openCustodyEpisodeRows: [],
  rabiesEvents: [],
  serviceDog: undefined,
  lostContext: null,
  lostTattooPhotoUrl: null,
  registryClaim: { registryBacked: false, identityHeading: "Identidad registrada en miMAR" },
} as unknown as CredentialViewData;

const OK_LOOKUP = { status: "ok", pet: ACTIVE_PET, photoUrl: null, data: VIEW_DATA } as const;

/** The limiter stub that lets a request through while recording it. */
const ALLOW = () => {};

// ---------------------------------------------------------------------------
// Fixtures for the LOST projection — the Tier-1 reveal
// ---------------------------------------------------------------------------
//
// Every disclosure toggle ON and no dispute: the maximal reveal, so each test
// below turns exactly ONE thing off and names what disappeared. A fixture that
// started minimal would have proved nothing — a gate that never fires and a
// field that is never populated look identical from the outside.

/** A pet whose owner opted into every lost-mode disclosure. */
const LOST_PET = {
  ...ACTIVE_PET,
  status: "lost",
  color: "negro",
  distinguishingFeatures: "mancha blanca en el pecho",
  allowFinderFormWhenLost: true,
  discloseFirstNameWhenLost: true,
  disclosePhoneWhenLost: true,
  discloseEmailWhenLost: true,
  discloseLastLocationWhenLost: true,
} as unknown as Pet;

/** Owner PII the loader resolved. NONE of it may reach a payload ungated. */
const OWNER_PHONE = "+5492901555123";
const OWNER_EMAIL = "ana.perdida@example.test";
const CARETAKER_PHONE = "+5492901555999";
const LOST_PLACE = "Plaza Piedrabuena";

const LOST_CONTEXT = {
  ownerFirstName: "Ana",
  phone: OWNER_PHONE,
  email: OWNER_EMAIL,
  locationText: LOST_PLACE,
  lastSeenCoords: "-54.801910, -68.302950",
  lastSeenAt: new Date("2026-08-19T15:00:00.000Z"),
  lostLat: -54.80191,
  lostLng: -68.30295,
  lostDescription: {
    accessoriesWhenLost: "collar rojo",
    behaviorNotes: "asustadiza con desconocidos",
    lastSeenContext: "se escapó por el portón",
  },
  lostSince: new Date("2026-08-18T09:00:00.000Z"),
  caretakerContact: { firstName: "Beto", phoneE164: CARETAKER_PHONE },
};

const NOW = new Date("2026-08-20T12:00:00.000Z");

/**
 * The `lost` section a given pet + lost context projects to.
 *
 * Goes through `buildPublicCredentialV1` rather than reaching for the private
 * `lostSectionOf`, because the thing under test is what a CLIENT receives — a
 * gate applied correctly in a helper and then bypassed by the assembler is a
 * bug this would have to catch.
 */
function lostSectionFor(
  petOverrides: Partial<Record<string, unknown>> = {},
  contextOverrides: Partial<Record<string, unknown>> = {},
) {
  const pet = { ...LOST_PET, ...petOverrides } as unknown as Pet;
  const data = {
    ...VIEW_DATA,
    lostContext: { ...LOST_CONTEXT, ...contextOverrides },
  } as unknown as CredentialViewData;
  const body = buildPublicCredentialV1({ status: "ok", pet, photoUrl: null, data }, NOW);
  expect(body.lost.status).toBe("ok");
  return body.lost.status === "ok" ? body.lost.data : null;
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

describe("GET /api/v1/pets/[publicToken]/credential — status mapping", () => {
  it("429s on the PER-LOOKUP limiter, through the door, before any pet row", async () => {
    control.rateLimit = (endpoint) => {
      if (endpoint === LOOKUP_BUCKET)
        throw new RateLimitError(new Date(Date.now() + 60_000), endpoint);
    };

    const seen = await observe(await get(TOKEN));

    expect(seen.status).toBe(429);
    expect(seen.body).toEqual({ error: "rate_limited" });
    // BOTH limiters now live inside the door's throttle port, and the door runs
    // it before `findPet` (proved without a database in
    // lookup-public-credential.test.ts). What this asserts is the ORDER WITHIN
    // the port: the surface bucket is consulted first, and the per-lookup write
    // only happens for a caller the surface limit still allows.
    expect(control.calls).toEqual(["door", `limit:${SURFACE_BUCKET}`, `limit:${LOOKUP_BUCKET}`]);
  });

  it("keys the per-lookup limiter by token AND caller (D3)", async () => {
    const keys: string[] = [];
    control.rateLimit = (endpoint, identifier) => {
      if (endpoint === LOOKUP_BUCKET) keys.push(identifier);
    };

    await get("DIM-AAAA-0001", "203.0.113.7");
    await get("DIM-BBBB-0002", "203.0.113.7");

    // Token-first so the counters read as "this credential, from this caller".
    // A key of the IP alone would duplicate the surface bucket; a key of the
    // TOKEN alone would let anyone burn a victim credential's global budget.
    expect(keys).toEqual(["DIM-AAAA-0001:203.0.113.7", "DIM-BBBB-0002:203.0.113.7"]);
  });

  it("429s on the SURFACE limiter with a byte-identical response", async () => {
    control.rateLimit = (endpoint) => {
      if (endpoint === LOOKUP_BUCKET) throw new RateLimitError(new Date(), endpoint);
    };
    const perLookup = await observe(await get(TOKEN));

    control.rateLimit = (endpoint) => {
      if (endpoint === SURFACE_BUCKET) throw new RateLimitError(new Date(), endpoint);
    };
    const surface = await observe(await get(TOKEN));

    // Two limiters, ONE 429. A client that could tell them apart could probe
    // which budget it exhausted, and the difference has no legitimate use.
    expect(perLookup.status).toBe(429);
    expect(surface).toEqual(perLookup);
  });

  it("404s on not_found", async () => {
    control.rateLimit = ALLOW;
    control.door = () => ({ status: "not_found" });

    const seen = await observe(await get(TOKEN));

    expect(seen.status).toBe(404);
    expect(seen.body).toEqual({ error: "not_found" });
  });

  it("503s on degraded WITH the fields the degraded card renders", async () => {
    control.rateLimit = ALLOW;
    control.door = () => ({
      status: "degraded",
      publicToken: TOKEN,
      pet: { name: "Pampa", sex: "female", isLost: true, allowFinderForm: true },
    });

    const seen = await observe(await get(TOKEN));

    expect(seen.status).toBe(503);
    // NOT 404: a database outage is not "this token does not exist".
    expect(seen.body.error).toBe("temporarily_unavailable");
    expect(seen.body.identity).toEqual({
      status: "ok",
      data: { name: "Pampa", sex: "female", isLost: true, allowFinderForm: true },
    });
    // Every other section says it could not be loaded. NEVER an empty object:
    // a native client renders a blank section as "a valid credential with no
    // findings" (RN-8 #6), which is the failure this contract exists for.
    for (const section of ["status", "vaccination", "notices", "lost", "tier2"] as const) {
      expect(seen.body[section]).toEqual({ status: "unavailable" });
    }
    expect(seen.headers["retry-after"]).toBe("30");
  });

  it("503s on degraded BARE with identity unavailable too", async () => {
    control.rateLimit = ALLOW;
    control.door = () => ({ status: "degraded", publicToken: TOKEN });

    const seen = await observe(await get(TOKEN));

    expect(seen.status).toBe(503);
    // The pet ROW itself failed, so the token really is all that is known.
    // Saying so beats inventing a name.
    expect(seen.body.identity).toEqual({ status: "unavailable" });
    expect(seen.body.publicToken).toBe(TOKEN);
  });

  it("200s on ok with every section present and reporting ok", async () => {
    control.rateLimit = ALLOW;
    control.door = () => OK_LOOKUP;

    const seen = await observe(await get(TOKEN));

    expect(seen.status).toBe(200);
    for (const section of [
      "identity",
      "status",
      "vaccination",
      "notices",
      "lost",
      "tier2",
    ] as const) {
      expect(seen.body[section].status).toBe("ok");
    }
    expect(seen.body.identity.data).toMatchObject({
      name: "Pampa",
      species: "dog",
      breed: "Mestizo",
      sex: "female",
      hasMicrochip: false,
      hasTattoo: false,
      libretaCode: `LIB-AR-${TOKEN}`,
    });
    // "loaded, and this pet is not lost" — distinct from "could not load".
    expect(seen.body.lost).toEqual({ status: "ok", data: null });
    // The Tier-2 medical projection is a separate streamed read this door does
    // not make. It says so rather than rendering as an empty history.
    expect(seen.body.tier2.data.medical).toBe("not_included");
  });
});

// ---------------------------------------------------------------------------
// Limiter ORDER, and the write amplification it bounds
// ---------------------------------------------------------------------------
//
// The two limiters used to run in the wrong order: the per-lookup bucket (keyed
// `${token}:${ip}`, TWO upserts into rate_limit_buckets — a minute row and an
// hour row) was consulted in the route, before the door applied the per-IP
// surface bucket. So an IP already over 60/min still wrote two rows for every
// distinct token it asked for, and the token is attacker-chosen: the cardinality
// of the table was bounded by how many tokens someone cared to type, not by the
// limit that exists to bound exactly that.
//
// Fixing it by moving the surface check earlier in the route would have DOUBLE
// COUNTED — the door applies the surface bucket itself. So the two live in one
// port instead, ordered inside the adapter.

describe("limiter order (C3)", () => {
  it("consults the SURFACE bucket before it writes a per-lookup counter", async () => {
    control.rateLimit = ALLOW;

    await get("DIM-ORDER-0001");

    expect(limiterCalls()).toEqual([`limit:${SURFACE_BUCKET}`, `limit:${LOOKUP_BUCKET}`]);
  });

  it("writes NO per-lookup counter for a caller already over the surface limit", async () => {
    control.rateLimit = (endpoint) => {
      if (endpoint === SURFACE_BUCKET) throw new RateLimitError(new Date(), endpoint);
    };

    const seen = await observe(await get("DIM-ORDER-0002"));

    expect(seen.status).toBe(429);
    // THE POINT OF THE ORDER. A throttled IP walking the token space must cost
    // the table zero rows per token, not two.
    expect(limiterCalls()).toEqual([`limit:${SURFACE_BUCKET}`]);
  });

  it("still spends the per-lookup budget for a caller the surface limit allows", async () => {
    // NON-VACUITY for the two above: the per-lookup limiter must not have been
    // "fixed" by simply never running.
    control.rateLimit = ALLOW;
    await get("DIM-ORDER-0003");
    expect(limiterCalls()).toContain(`limit:${LOOKUP_BUCKET}`);
  });
});

// ---------------------------------------------------------------------------
// The ceilings the route actually applies (B13)
// ---------------------------------------------------------------------------
//
// The ordering tests above prove WHICH buckets are consulted and in what order.
// They say nothing about the numbers, and the numbers are the whole of B13: this
// endpoint's caller is a phone behind Argentine carrier NAT, where one public
// IPv4 is shared by 500-1,000 subscribers, so it needs a per-IP ceiling of its
// own instead of sharing the four HTML surfaces' bucket. (Those four were at
// 60/min + 400/hr when B13's first half landed; its second half raised them to
// the same 600/min + 6,000/hr, so what this endpoint has of its own today is
// the BUCKET, not a larger ceiling.)
//
// The failure this catches is a deletion, not a typo: drop `surfaceLimit:` from
// the route's `publicTokenThrottle(...)` options and the endpoint silently falls
// back to the default — every assertion in this file still green, and one
// carrier gateway's worth of finders refused.

describe("per-IP and per-lookup ceilings (B13)", () => {
  function configFor(bucket: string): unknown {
    return control.limits.find((entry) => entry.endpoint === bucket)?.config;
  }

  it("applies the endpoint's OWN per-IP ceiling to the surface bucket", async () => {
    control.rateLimit = ALLOW;
    await get("DIM-B13-0001");
    expect(configFor(SURFACE_BUCKET)).toEqual(PUBLIC_TOKEN_API_SURFACE_LIMIT);
  });

  it("applies the per-lookup ceiling to the per-lookup bucket", async () => {
    control.rateLimit = ALLOW;
    await get("DIM-B13-0002");
    expect(configFor(LOOKUP_BUCKET)).toEqual(PUBLIC_TOKEN_API_LOOKUP_LIMIT);
  });

  // THIS ASSERTION CHANGED SHAPE ON 2026-08-25, and the reason is worth stating.
  //
  // It used to read `expect(configFor(SURFACE_BUCKET)).not.toEqual(
  // PUBLIC_TOKEN_READ_LIMIT)` plus `expect(PUBLIC_TOKEN_READ_LIMIT).toEqual({
  // maxPerMinute: 60, maxPerHour: 400 })` — "this endpoint does not fall back to
  // the HTML surfaces' default". That was the right thing to pin when B13 had
  // raised only this endpoint and left the four HTML surfaces behind.
  //
  // B13 part 2 then applied the same arithmetic to those four, so the two
  // constants now hold the SAME numbers. The old `not.toEqual` would fail — not
  // because the endpoint regressed, but because the difference it was watching
  // stopped existing. Bumping it to a fresh `not.toEqual` would be worse: it
  // would demand the two stay different for no reason anyone could name.
  //
  // What is still true and still worth defending is the ORDERING invariant: this
  // endpoint's ceiling may never end up BELOW the shared HTML default. Its
  // caller is a phone behind CGNAT; silently inheriting a tighter page limit is
  // the regression that would actually hurt. That they currently coincide is a
  // fact, not a requirement, and the assertion says so.
  it("never sits below the shared HTML default, and owns its ceiling explicitly", async () => {
    control.rateLimit = ALLOW;
    await get("DIM-B13-0003");

    // Explicitly its own constant — not inherited by omitting the argument.
    expect(configFor(SURFACE_BUCKET)).toEqual(PUBLIC_TOKEN_API_SURFACE_LIMIT);

    expect(PUBLIC_TOKEN_API_SURFACE_LIMIT.maxPerMinute ?? 0).toBeGreaterThanOrEqual(
      PUBLIC_TOKEN_READ_LIMIT.maxPerMinute ?? 0,
    );
    expect(PUBLIC_TOKEN_API_SURFACE_LIMIT.maxPerHour ?? 0).toBeGreaterThanOrEqual(
      PUBLIC_TOKEN_READ_LIMIT.maxPerHour ?? 0,
    );
  });

  // The property the arithmetic in limits.ts rests on: the per-lookup bucket
  // stays the TIGHT one, so a caller that reaches the surface ceiling is
  // provably spreading across several tokens rather than hammering one card.
  it("keeps the per-lookup ceiling strictly below the surface ceiling", () => {
    expect(PUBLIC_TOKEN_API_LOOKUP_LIMIT.maxPerMinute).toBeLessThan(
      PUBLIC_TOKEN_API_SURFACE_LIMIT.maxPerMinute ?? 0,
    );
    expect(PUBLIC_TOKEN_API_LOOKUP_LIMIT.maxPerHour).toBeLessThan(
      PUBLIC_TOKEN_API_SURFACE_LIMIT.maxPerHour ?? 0,
    );
  });

  // THE CGNAT FLOOR. One public IPv4 carries ~1,000 subscribers here; the
  // modelled ordinary hour is 10% of them opening a credential ~6 times, and
  // the poster case is 10% of them opening the SAME credential twice. Both must
  // fit with room to spare, or the limit refuses a gateway during normal use —
  // which is what 400/hr and 100/hr did.
  it("leaves room for a carrier gateway's ordinary hour", () => {
    const SUBSCRIBERS_PER_PUBLIC_IP = 1_000;
    const ACTIVE_FRACTION = 0.1;
    const READS_PER_ACTIVE_USER = 6;
    const modelledHour = SUBSCRIBERS_PER_PUBLIC_IP * ACTIVE_FRACTION * READS_PER_ACTIVE_USER;

    expect(modelledHour).toBe(600);
    // The old 400/hr did not clear this at all.
    expect(PUBLIC_TOKEN_API_SURFACE_LIMIT.maxPerHour ?? 0).toBeGreaterThanOrEqual(modelledHour * 5);
  });

  it("leaves room for a viral poster on one gateway", () => {
    const NEIGHBOURS_SCANNING_THE_SAME_POSTER = 1_000 * 0.1;
    const READS_EACH = 2;
    const posterHour = NEIGHBOURS_SCANNING_THE_SAME_POSTER * READS_EACH;

    expect(posterHour).toBe(200);
    // The old 100/hr refused the 51st neighbour.
    expect(PUBLIC_TOKEN_API_LOOKUP_LIMIT.maxPerHour ?? 0).toBeGreaterThanOrEqual(posterHour * 5);
  });
});

// ---------------------------------------------------------------------------
// Fail-open — the arm nothing exercised before
// ---------------------------------------------------------------------------
//
// Rate limiting on this surface is an ABUSE CONTROL, not an authorization
// boundary: nothing behind it is secret to someone already holding the token.
// The limiter is itself a DB write, so a limiter that has stopped working must
// not become the thing that breaks the credential before the degraded answer
// can be produced. That arm existed and had never been executed by a test —
// which is the same as not knowing whether it works.

describe("the limiters fail OPEN", () => {
  /** The port the route hands the door, with both buckets bound. */
  function routeThrottle() {
    return publicTokenThrottle(SURFACE_BUCKET, {
      perLookup: {
        bucket: LOOKUP_BUCKET,
        key: `${TOKEN}:203.0.113.9`,
        limit: PUBLIC_TOKEN_API_LOOKUP_LIMIT,
      },
    });
  }

  it("lets the read through when the per-lookup limiter throws a NON-RateLimitError", async () => {
    control.rateLimit = (endpoint) => {
      if (endpoint === LOOKUP_BUCKET) throw new Error("rate_limit_buckets: connection reset");
    };

    expect(await routeThrottle().isThrottled()).toBe(false);
    // Reported, because a limiter that stopped working is an incident even
    // though the request continues.
    expect(reportedErrors()).toContain(`public-token-throttle/${LOOKUP_BUCKET}`);
  });

  it("lets the read through when the per-lookup limiter blows its DB budget", async () => {
    // withDbBudget RESOLVES with its fallback on timeout rather than throwing,
    // so this arm never reaches the catch clause at all — which is exactly why
    // it needs its own test. A limiter that simply never answers must cost the
    // caller the budget and nothing else.
    control.rateLimit = (endpoint) =>
      endpoint === LOOKUP_BUCKET ? new Promise<void>(() => {}) : undefined;

    expect(await routeThrottle().isThrottled()).toBe(false);
  }, 10_000);

  it("lets the read through when the SURFACE limiter throws a NON-RateLimitError", async () => {
    control.rateLimit = (endpoint) => {
      if (endpoint === SURFACE_BUCKET) throw new Error("rate_limit_buckets: connection reset");
    };

    expect(await routeThrottle().isThrottled()).toBe(false);
    expect(reportedErrors()).toContain(`public-token-throttle/${SURFACE_BUCKET}`);
    // Fail-open means the CALLER continues, and continuing means the per-lookup
    // limiter still runs — a surface store that broke must not silently take
    // D3's counter with it. It is also what bounds the write amplification the
    // route header states: at most 120 rows/min per IP, a number that assumes
    // the surface bucket and the per-lookup bucket are consulted on the same
    // path. Asserting only `isThrottled() === false` would pass on an
    // implementation that abandoned the per-lookup check entirely.
    expect(limiterCalls()).toEqual([`limit:${SURFACE_BUCKET}`, `limit:${LOOKUP_BUCKET}`]);
  });

  it("does NOT fail open on a genuine RateLimitError — the arm above is not a hole", async () => {
    // NON-VACUITY for the three above: if `isThrottled` had been mutated to
    // `return false`, every fail-open assertion would still pass.
    control.rateLimit = (endpoint) => {
      throw new RateLimitError(new Date(), endpoint);
    };

    expect(await routeThrottle().isThrottled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Envelope and headers — the two things §4 and §6 require on every response
// ---------------------------------------------------------------------------

describe("envelope and headers", () => {
  const branches = [
    ["per-lookup 429", () => ({ rateLimit: true }) as const],
    ["surface 429", () => ({ door: { status: "throttled" } }) as const],
    ["404", () => ({ door: { status: "not_found" } }) as const],
    ["503", () => ({ door: { status: "degraded", publicToken: TOKEN } }) as const],
    ["200", () => ({ door: OK_LOOKUP }) as const],
  ] as const;

  for (const [label, setup] of branches) {
    it(`sets cache-control: no-store on ${label}`, async () => {
      const config = setup() as { rateLimit?: boolean; door?: unknown };
      control.rateLimit = config.rateLimit
        ? (endpoint) => {
            throw new RateLimitError(new Date(), endpoint);
          }
        : ALLOW;
      if (config.door) control.door = () => config.door;

      const response = await get(TOKEN);

      // §4: middleware's no-store allowlist is a PATH PREFIX list and `/api/`
      // is not on it. Every branch sets it itself or the branch is a hole.
      expect(response.headers.get("cache-control")).toBe("no-store");
    });
  }

  it("carries payloadVersion / issuedAt / staleAfter on a successful read", async () => {
    control.rateLimit = ALLOW;
    control.door = () => OK_LOOKUP;

    const body = await (await get(TOKEN)).json();

    expect(body.payloadVersion).toBe(1);
    expect(Number.isNaN(Date.parse(body.issuedAt))).toBe(false);
    expect(Date.parse(body.staleAfter) - Date.parse(body.issuedAt)).toBe(
      PUBLIC_CREDENTIAL_STALE_AFTER_MS,
    );
  });

  it("carries the same envelope on a DEGRADED read", async () => {
    control.rateLimit = ALLOW;
    control.door = () => ({ status: "degraded", publicToken: TOKEN });

    const body = await (await get(TOKEN)).json();

    // One parser for both. A degraded answer that dropped the envelope would
    // force a client to special-case 503 before it could even timestamp it.
    expect(body.payloadVersion).toBe(1);
    expect(Date.parse(body.staleAfter) - Date.parse(body.issuedAt)).toBe(
      PUBLIC_CREDENTIAL_STALE_AFTER_MS,
    );
  });

  it("omits payloadVersion from 404 and 429 — they carry no payload", async () => {
    control.rateLimit = ALLOW;
    control.door = () => ({ status: "not_found" });
    expect(Object.keys(await (await get(TOKEN)).json())).toEqual(["error"]);

    control.door = () => ({ status: "throttled" });
    expect(Object.keys(await (await get(TOKEN)).json())).toEqual(["error"]);
  });
});

// ---------------------------------------------------------------------------
// The anti-oracle properties (§1.1, §9 item 10)
// ---------------------------------------------------------------------------
//
// Shaped after __tests__/denuncia-access-timing-oracle.test.ts, which
// api-invariants.md names as the model: assert the PROPERTY (two responses are
// the same), never a restated constant.

describe("response equality — no existence oracle", () => {
  it("makes not_found and throttled differ ONLY in status and error code", async () => {
    control.rateLimit = ALLOW;

    control.door = () => ({ status: "not_found" });
    const notFound = await observe(await get(TOKEN));
    control.door = () => ({ status: "throttled" });
    const throttled = await observe(await get(TOKEN));

    expect(notFound.status).toBe(404);
    expect(throttled.status).toBe(429);
    expect(notFound.body).toEqual({ error: "not_found" });
    expect(throttled.body).toEqual({ error: "rate_limited" });
    // Everything else identical: same header set, same values, same body shape.
    // This is where a `Retry-After`, a `x-ratelimit-remaining`, or an
    // echoed-back token would show up — each of them a channel that says
    // something about the token the status code alone does not.
    expect(throttled.headers).toEqual(notFound.headers);
    expect(Object.keys(throttled.body)).toEqual(Object.keys(notFound.body));
  });

  it("answers a throttled caller identically whatever the token is", async () => {
    control.rateLimit = ALLOW;
    control.door = () => ({ status: "throttled" });

    const real = await observe(await get(TOKEN));
    const nonsense = await observe(await get("DIM-ZZZZ-ZZZZ"));

    // A 429 that varied with the token would turn the rate limiter itself into
    // the enumeration oracle it exists to prevent.
    expect(nonsense).toEqual(real);
  });
});

// ---------------------------------------------------------------------------
// The LOST section — the only place this endpoint discloses owner PII
// ---------------------------------------------------------------------------
//
// Everything else on this credential is about the ANIMAL. This section is about
// a person: their first name, their phone, their email, and where they last saw
// their pet. It is the highest-risk projection in the file and it had no test
// of its own — the route tests all ran an ACTIVE pet, for which the whole
// section is `null` and every gate below is unreachable.

describe("the lost section — every disclosure gate", () => {
  it("is null for a pet nobody is looking for, whatever the toggles say", () => {
    // The toggles are all ON here. `status !== "lost"` outranks every one.
    const body = buildPublicCredentialV1(
      {
        status: "ok",
        pet: { ...LOST_PET, status: "active" } as unknown as Pet,
        photoUrl: null,
        data: { ...VIEW_DATA, lostContext: LOST_CONTEXT } as unknown as CredentialViewData,
      },
      NOW,
    );
    expect(body.lost).toEqual({ status: "ok", data: null });
    expect(JSON.stringify(body)).not.toContain(OWNER_PHONE);
  });

  it("discloses the phone ONLY under disclosePhoneWhenLost", () => {
    expect(lostSectionFor()?.owner.phoneE164).toBe(OWNER_PHONE);
    expect(lostSectionFor({ disclosePhoneWhenLost: false })?.owner.phoneE164).toBeNull();
  });

  it("discloses the first name ONLY under discloseFirstNameWhenLost", () => {
    expect(lostSectionFor()?.owner.firstName).toBe("Ana");
    expect(lostSectionFor({ discloseFirstNameWhenLost: false })?.owner.firstName).toBeNull();
  });

  it("discloses the email ONLY under discloseEmailWhenLost", () => {
    expect(lostSectionFor()?.owner.email).toBe(OWNER_EMAIL);
    expect(lostSectionFor({ discloseEmailWhenLost: false })?.owner.email).toBeNull();
  });

  it("gates each owner field SEPARATELY — one toggle off never suppresses another", () => {
    // The failure this catches is a single `if (!disclose…) return { owner: {} }`
    // shortcut: it would pass all three tests above and lose two real fields.
    const only = lostSectionFor({ discloseEmailWhenLost: false });
    expect(only?.owner).toEqual({ firstName: "Ana", phoneE164: OWNER_PHONE, email: null });
  });

  it("discloses last-seen ONLY under discloseLastLocationWhenLost", () => {
    const shown = lostSectionFor()?.lastSeen;
    expect(shown).toEqual({
      placeName: LOST_PLACE,
      locality: "Ushuaia",
      coords: "-54.801910, -68.302950",
      lat: -54.80191,
      lng: -68.30295,
      at: "2026-08-19T15:00:00.000Z",
    });

    const hidden = lostSectionFor({ discloseLastLocationWhenLost: false });
    expect(hidden?.lastSeen).toBeNull();
    // The locality rides INSIDE lastSeen, so hiding the location hides it too —
    // the pet's jurisdiction column must not leak around the gate.
    expect(JSON.stringify(hidden)).not.toContain("Ushuaia");
  });

  it("passes the caretaker contact through only when the loader resolved one", () => {
    expect(lostSectionFor()?.caretakerContact).toEqual({
      firstName: "Beto",
      phoneE164: CARETAKER_PHONE,
    });
    expect(lostSectionFor({}, { caretakerContact: null })?.caretakerContact).toBeNull();
  });

  it("suppresses EVERY contact and both report actions during a custody dispute", () => {
    const disputed = lostSectionFor({ inCustodyDispute: true });

    // D2 hardening (red-team 2026-07): while titularidad is under review the
    // system must neither publish the contested owner's contact nor relay a
    // finder's, because both end in an owner-directed notification.
    expect(disputed?.owner).toEqual({ firstName: null, phoneE164: null, email: null });
    expect(disputed?.allowFinderForm).toBe(false);
    expect(disputed?.allowSighting).toBe(false);
    // A third party's number is contact too. The loader already nulls it under
    // dispute; this file re-applies the gate rather than trusting it, which is
    // the rule stated in payload.ts's own header.
    expect(disputed?.caretakerContact).toBeNull();

    const serialized = JSON.stringify(disputed);
    for (const secret of [OWNER_PHONE, OWNER_EMAIL, CARETAKER_PHONE, "Ana"]) {
      expect(serialized, `disputed payload leaked ${secret}`).not.toContain(secret);
    }
  });

  it("keeps the ANIMAL's own details under dispute — suppression is about people", () => {
    // The over-correction this catches: blanking the section wholesale during a
    // dispute would delete the colour, the marks and the tattoo, which are the
    // only things a stranger can match against the animal in front of them.
    const disputed = lostSectionFor({ inCustodyDispute: true });
    expect(disputed?.color).toBe("negro");
    expect(disputed?.distinguishingFeatures).toBe("mancha blanca en el pecho");
    expect(disputed?.description).toEqual(LOST_CONTEXT.lostDescription);
    expect(disputed?.since).toBe("2026-08-18T09:00:00.000Z");
  });

  it("reveals nothing but the animal when every toggle is off", () => {
    const minimal = lostSectionFor({
      discloseFirstNameWhenLost: false,
      disclosePhoneWhenLost: false,
      discloseEmailWhenLost: false,
      discloseLastLocationWhenLost: false,
      allowFinderFormWhenLost: false,
    });

    expect(minimal?.owner).toEqual({ firstName: null, phoneE164: null, email: null });
    expect(minimal?.lastSeen).toBeNull();
    expect(minimal?.allowFinderForm).toBe(false);
    // Still findable: a sighting needs no owner contact and stays available.
    expect(minimal?.allowSighting).toBe(true);
    expect(minimal?.color).toBe("negro");
  });

  it("carries the tattoo, and only the tattoo, as a lost-mode identifier", () => {
    const withMarks = buildPublicCredentialV1(
      {
        status: "ok",
        pet: LOST_PET,
        photoUrl: null,
        data: {
          ...VIEW_DATA,
          lostContext: LOST_CONTEXT,
          canonicalIds: {
            microchip: { code: "900123456789012" },
            tattoo: { code: "TAT-99", tattooLocation: "oreja", tattooDescription: "azul" },
          },
          lostTattooPhotoUrl: "https://example.test/tattoo.jpg",
        } as unknown as CredentialViewData,
      },
      NOW,
    );

    expect(withMarks.lost.status === "ok" && withMarks.lost.data?.tattoo).toEqual({
      code: "TAT-99",
      location: "oreja",
      description: "azul",
      photoUrl: "https://example.test/tattoo.jpg",
    });
    // A chip needs a reader. Publishing the number helps nobody standing over
    // the animal and hands a scraper a national identifier — lost mode included.
    expect(JSON.stringify(withMarks)).not.toContain("900123456789012");
    expect(withMarks.identity.status === "ok" && withMarks.identity.data.hasMicrochip).toBe(true);
  });

  it("carries NO lost data at all in the degraded envelope", () => {
    // The degraded arm knows the pet is lost (the card renders its CTAs) and
    // must still publish none of the Tier-1 reveal: the section that would
    // carry it did not load, and `unavailable` is the honest word for that.
    const degraded = buildDegradedPublicCredentialV1(
      {
        status: "degraded",
        publicToken: TOKEN,
        pet: { name: "Pampa", sex: "female", isLost: true, allowFinderForm: true },
      },
      NOW,
    );

    expect(degraded.lost).toEqual({ status: "unavailable" });
    const serialized = JSON.stringify(degraded);
    for (const secret of [OWNER_PHONE, OWNER_EMAIL, CARETAKER_PHONE, LOST_PLACE, "-54.80191"]) {
      expect(serialized, `degraded payload leaked ${secret}`).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------------------
// The three pass-throughs (C5)
// ---------------------------------------------------------------------------
//
// `data: lookup.pet`, `caretakerContact: lostContext.caretakerContact` and
// `description: lostContext.lostDescription` are assigned WHOLE. TypeScript's
// excess-property check only fires on object LITERALS, so if an upstream type
// grows a field, all three widen silently and the new field ships. These pin
// the key sets so that widening is a failing test instead of a disclosure.

describe("whole-object pass-throughs cannot widen silently", () => {
  it("pins the degraded identity payload to the degraded card's four props", () => {
    const degraded = buildDegradedPublicCredentialV1(
      {
        status: "degraded",
        publicToken: TOKEN,
        pet: { name: "Pampa", sex: "female", isLost: true, allowFinderForm: true },
      },
      NOW,
    );
    expect(degraded.identity.status).toBe("ok");
    const data = degraded.identity.status === "ok" ? degraded.identity.data : {};
    expect(Object.keys(data).sort()).toEqual(["allowFinderForm", "isLost", "name", "sex"]);
  });

  it("pins the caretaker contact to first name and phone", () => {
    expect(Object.keys(lostSectionFor()?.caretakerContact ?? {}).sort()).toEqual([
      "firstName",
      "phoneE164",
    ]);
  });

  it("pins the lost description to its three animal-detail fields", () => {
    expect(Object.keys(lostSectionFor()?.description ?? {}).sort()).toEqual([
      "accessoriesWhenLost",
      "behaviorNotes",
      "lastSeenContext",
    ]);
  });

  it("drops a field an upstream type grew but the contract never declared", () => {
    // The simulation of the exact accident: the loader starts resolving the
    // caretaker's EMAIL, and nobody remembers that this file forwards the whole
    // object. A pass-through ships it; a listed projection does not.
    const widened = lostSectionFor(
      {},
      {
        caretakerContact: {
          firstName: "Beto",
          phoneE164: CARETAKER_PHONE,
          email: "beto@example.test",
        },
      },
    );
    expect(JSON.stringify(widened)).not.toContain("beto@example.test");
  });

  it("drops a lost-description field an upstream type grew", () => {
    const widened = lostSectionFor(
      {},
      {
        lostDescription: {
          ...LOST_CONTEXT.lostDescription,
          ownerNotes: "vive en Perito Moreno 1234",
        },
      },
    );
    expect(JSON.stringify(widened)).not.toContain("Perito Moreno 1234");
  });
});

// ---------------------------------------------------------------------------
// Against the real database
// ---------------------------------------------------------------------------

describe("against a real pet row", () => {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const liveToken = `DIM-APIV1-${suffix}`;
  const erasedToken = `DIM-APIER-${suffix}`;
  // 15 digits, the ISO chip shape. It exists in the database, the credential
  // says "Microchip: Sí", and it must appear nowhere in the JSON.
  const chipCode = `900${Date.now()}`.slice(0, 15);
  const createdTokens = [liveToken, erasedToken];

  afterAll(async () => {
    const rows = await db
      .select({ id: pets.id })
      .from(pets)
      .where(inArray(pets.publicToken, createdTokens));
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await db.delete(petIdentifications).where(inArray(petIdentifications.petId, ids));
      await db.delete(pets).where(inArray(pets.id, ids));
    }
  });

  it("serves a live credential without a single internal id or DNI-shaped value", async () => {
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: liveToken,
        name: "Pampa API",
        species: "dog",
        sex: "female",
        status: "active",
      })
      .returning();
    await db.insert(petIdentifications).values({
      petId: pet.id,
      kind: "microchip_iso",
      code: chipCode,
      recordedAt: new Date().toISOString().slice(0, 10),
    });

    const response = await get(liveToken);
    expect(response.status).toBe(200);
    const body = await response.json();
    const serialized = JSON.stringify(body);

    // The chip is ON RECORD and the credential says so — which is the whole
    // point of measuring this against a real row rather than a fixture that
    // simply had no chip to leak.
    expect(body.identity.data.hasMicrochip).toBe(true);
    expect(serialized).not.toContain(chipCode);
    // No internal identifier of any kind: pet id, attachment id, case id.
    expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(serialized).not.toContain(pet.id);
    // Nothing DNI-shaped on any string leaf (Ley 25.326 — and invariant #5,
    // which forbids a plaintext DNI anywhere, credential included).
    const leaves = stringLeaves(body);
    // NON-VACUITY: a `for` over an empty list passes loudly enough to look like
    // proof. If the walker stops descending, this is what says so.
    expect(leaves.length).toBeGreaterThan(5);
    expect(leaves).toContain("Pampa API");
    for (const leaf of leaves) {
      // Both spellings. The bare-digit form is how the column would serialise;
      // the DOTTED form is how a human types it into a free-text field, which
      // is the realistic way one reaches a payload at all (a note, a
      // distinguishing-features box). A canary that knew only one spelling
      // would have watched the likelier one go past.
      expect(leaf, `DNI-shaped leaf in the payload: ${leaf}`).not.toMatch(
        /(^|\D)\d{2}\.\d{3}\.\d{3}(\D|$)/,
      );
      expect(leaf, `DNI-shaped leaf in the payload: ${leaf}`).not.toMatch(/^\d{7,8}$/);
    }
  });

  it("answers an ERASED pet exactly as it answers a token that never existed", async () => {
    await db.insert(pets).values({
      publicToken: erasedToken,
      name: "Erased",
      species: "cat",
      sex: "male",
      status: "active",
      deletedAt: new Date(),
    });

    const erased = await observe(await get(erasedToken));
    const neverExisted = await observe(await get(`DIM-NONE-${suffix}`));

    // PO-4 / Ley 25.326 art. 16: erasing a subject soft-deletes the pets in
    // their custody and the credential goes dark. If the two answers differed
    // by so much as a header, the erasure would be observable — which is the
    // one thing an erasure may never be.
    expect(erased).toEqual(neverExisted);
    expect(erased.status).toBe(404);
  });
});

/** Every string leaf of a parsed JSON value, depth-first. */
function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(stringLeaves);
  }
  return [];
}
