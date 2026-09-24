// POST /api/v1/pets — the first `/api/v1` endpoint that CHANGES something.
//
// WHAT THIS FILE HAS TO PROVE, AND WHY EACH PART EXISTS
// ---------------------------------------------------------------------------
// `registerPet` is already covered as a use-case, and the breed matcher, the
// locality validator and the dedupe scan each have their own tests. This file
// proves the things that are the ROUTE's own and that no other test can see:
//
//   1. IDEMPOTENCY IS A REQUIREMENT, NOT A SUGGESTION. The header is refused
//      when absent, with its own code — and refused BEFORE the limiter, so a
//      client that got the envelope wrong costs the platform no counter write.
//      Present, it reaches `registerPet` as `clientIdempotencyKey`; a replay
//      answers 201 with the FIRST attempt's token and `wasDuplicate: true`.
//      That last one is the whole reason this endpoint can be retried at all,
//      and "the retry created a second dog" is unrecoverable by the person it
//      happens to.
//   2. THE GATES RUN. An off-catalog breed is refused by the SERVER even though
//      the catalog now ships to clients (QA A4 — "the client had the list" is
//      not a boundary). The same-owner dedupe refuses, and `duplicateOverride`
//      is what gets past it.
//   3. THE AUTH MAPPING is byte-identical to `/me`'s, because a native client
//      writes one handler for the failure space.
//   4. `cache-control: no-store` on EVERY branch. It is NOT inherited —
//      middleware stamps it from a path-prefix allowlist `/api/…` does not
//      match — and a response describing a just-created pet is the last thing
//      that should sit in a shared cache.
//   5. THE PAYLOAD CARRIES NO INTERNAL IDS. `registerPet` hands back a `petId`
//      and an `eventId`; neither may reach the wire.
//
// HOW THE MOCKING WORKS. Every collaborator that touches the network or the
// database is replaced — this is a UNIT test of the adapter, deliberately. The
// two that are NOT mocked are the ones being asserted about: the real zod schema
// from the contract package, and the real `resolveBreedForWrite`, which needs no
// database and is the gate item 2 is about.

import { randomUUID } from "node:crypto";

import { registerPetInputSchema } from "@dim/contract/input";
import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  /** What the liveness guard answers. */
  live: null as null | (() => unknown),
  /** When set, the limiter throws it. */
  limiterThrows: null as null | (() => never),
  /** Every limiter bucket the handler spent, in order. */
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  /** What findSameOwnerDuplicatePet answers. */
  duplicate: null as null | { publicToken: string },
  /**
   * The `Idempotency-Key` the pet in `duplicate` was REGISTERED with, when the
   * case is modelling a retry of the attempt that created it (A2-alta-asentar-04).
   */
  duplicateRegistrationKey: null as null | string,
  /** Every argument findSameOwnerDuplicatePet received. */
  dedupeCalls: [] as Array<{ excludeClientIdempotencyKey?: string | null }>,
  /** Every `LocationValue` normalizeLocationForWrite received. */
  normalizeCalls: [] as Array<{ localityIndecId: string | null }>,
  /** What registerPet answers. */
  register: null as null | (() => unknown),
  /** Every argument registerPet received. */
  registerCalls: [] as Array<Record<string, unknown>>,
  /** Whether the locality validator should reject. */
  localityRejects: false,
}));

vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () =>
      control.live
        ? control.live()
        : {
            ok: true,
            supabase: {},
            // A COMPLETED identity by default. `profile: null` used to stand
            // here and is now the pending state the identity gate refuses — a
            // blank display name is exactly what `isIdentityPending` catches —
            // so the happy path has to state what a registered person looks
            // like: a real name that is not the address's local part.
            user: { id: OWNER_ID, email: "ana.gomez@example.com" },
            profile: { displayName: "Ana Gómez" },
          },
  };
});

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: async (endpoint: string, identifier: string) => {
      control.limits.push({ endpoint, identifier });
      control.limiterThrows?.();
    },
  };
});

vi.mock("@/lib/domain/location-normalize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/domain/location-normalize")>();
  return {
    ...actual,
    normalizeLocationForWrite: async (loc: { localityIndecId: string | null }) => {
      control.normalizeCalls.push(loc);
      if (control.localityRejects) {
        throw new actual.JurisdictionValidationError(
          "INVALID_LOCALITY",
          "La localidad no existe en el catálogo INDEC.",
        );
      }
      return {
        province: "Ciudad Autónoma de Buenos Aires",
        locality: "Villa Crespo",
        localityCanonical: true,
        localityId: LOCALITY_ID,
        lat: null,
        lng: null,
        address: null,
      };
    },
  };
});

vi.mock("@/lib/infra/owner-pet-dedupe", () => ({
  findSameOwnerDuplicatePet: async (input: { excludeClientIdempotencyKey?: string | null }) => {
    control.dedupeCalls.push(input);
    // The fake mirrors exactly ONE rule of the real scan: it skips the pet this
    // request's own key created. Recording the argument would not have been a
    // test — an argument nothing reads is not a fix — and the rule itself is
    // asserted directly in `lib/infra/owner-pet-dedupe.test.ts`.
    if (
      control.duplicate &&
      control.duplicateRegistrationKey &&
      input.excludeClientIdempotencyKey === control.duplicateRegistrationKey
    ) {
      return null;
    }
    return control.duplicate;
  },
}));

vi.mock("@/lib/infra/ppp-classification", () => ({
  resolvePppClassificationForJurisdiction: async () => false,
}));

vi.mock("@/lib/infra/notification-service", () => ({
  createNotificationsBulk: async () => ({
    insertedCount: 0,
    duplicateCount: 0,
    deadLetteredCount: 0,
  }),
}));

vi.mock("@/src/modules/pets/application/register-pet", () => ({
  registerPet: async (input: Record<string, unknown>) => {
    control.registerCalls.push(input);
    return control.register
      ? control.register()
      : {
          ok: true,
          value: {
            petId: PET_ID,
            eventId: EVENT_ID,
            publicToken: "DIM-TEST-0001",
            wasDuplicate: false,
          },
          notifications: [],
        };
  },
}));

// `@/db` is deliberately NOT mocked. The route imports it only to pass
// `db.transaction` into the use-case, which is mocked above and never calls it,
// so nothing here reaches Postgres. A factory stub was tried first and is the
// wrong answer: `@/db` is re-exported through half the infra graph (the guard
// pulls `request-cache`, which pulls `notification-reconcile`), so a partial
// mock turns into "No 'notifications' export is defined on the '@/db' mock" —
// a collection error that reports as a BROKEN FILE with zero failing tests.

import { RateLimitError } from "@/lib/infra/rate-limit";

import { POST } from "@/app/api/v1/pets/route";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PET_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const LOCALITY_ID = "44444444-4444-4444-8444-444444444444";

/** A body the contract schema accepts. Overridden per case. */
const VALID_BODY = {
  name: "Pampa",
  species: "dog",
  provinceCode: "AR-C",
  localityName: "Villa Crespo",
  sex: "female",
  breed: "Labrador",
  ageYears: "3",
};

function post(
  body: unknown,
  opts: { idempotencyKey?: string | null; bearer?: string | null } = {},
) {
  const headers: Record<string, string> = { "x-real-ip": "203.0.113.44" };
  const bearer = opts.bearer === undefined ? "Bearer test-token" : opts.bearer;
  if (bearer) headers.authorization = bearer;
  const key = opts.idempotencyKey === undefined ? randomUUID() : opts.idempotencyKey;
  if (key) headers["idempotency-key"] = key;
  return new Request("http://localhost:3000/api/v1/pets", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  control.live = null;
  control.limiterThrows = null;
  control.limits = [];
  control.duplicate = null;
  control.duplicateRegistrationKey = null;
  control.dedupeCalls = [];
  control.normalizeCalls = [];
  control.register = null;
  control.registerCalls = [];
  control.localityRejects = false;
});

// ---------------------------------------------------------------------------
// The envelope: the header this endpoint cannot work without
// ---------------------------------------------------------------------------

describe("POST /api/v1/pets — Idempotency-Key", () => {
  it("refuses a request with no Idempotency-Key, with its OWN code", async () => {
    const res = await POST(post(VALID_BODY, { idempotencyKey: null }));

    expect(res.status).toBe(400);
    // NOT `invalid_request`. The body was fine; the ENVELOPE was wrong, and
    // collapsing the two sends a client author hunting through a body schema
    // that was never the problem — the same reason `auth_required` is distinct
    // from `auth_expired`.
    expect(await res.json()).toEqual({ error: "idempotency_key_required" });
  });

  it("refuses a blank Idempotency-Key too — a header that is present and empty is absent", async () => {
    const res = await POST(post(VALID_BODY, { idempotencyKey: "   " }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "idempotency_key_required" });
  });

  // FB-1. `pet_events.client_idempotency_key` is a Postgres `uuid`, and this
  // endpoint used to accept any non-blank string. A ULID or a nanoid — both
  // perfectly ordinary idempotency keys, both what a native app may already
  // have on hand — was accepted here, carried into the transaction and raised
  // `22P02` inside it. That surfaced as `pet_registration_failed`, whose
  // contract tells the caller to retry with the SAME key: an identical 500,
  // forever, one failed registration at a time until the 10/min user budget
  // turned it into a 429.
  it.each([
    ["a ULID", "01JCK9Q7ZK8P6R3B4YV2M5X7QD"],
    ["a nanoid", "V1StGXR8_Z5jdHi6B-myT"],
    ["a UUID with the hyphens stripped", "1c2f9a6e5b3d4f8091a2b3c4d5e6f708"],
    ["a UUID with one character too many", "1c2f9a6e-5b3d-4f80-91a2-b3c4d5e6f7089"],
    ["a UUID with a non-hex character", "1c2f9a6e-5b3d-4f80-91a2-b3c4d5e6f70g"],
    ["a braced UUID", "{1c2f9a6e-5b3d-4f80-91a2-b3c4d5e6f708}"],
    ["prose", "retry-of-the-form-i-just-filled"],
  ])(
    "refuses %s — the column is a uuid, and a 500 is not a validation message",
    async (_label, key) => {
      const res = await POST(post(VALID_BODY, { idempotencyKey: key }));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "idempotency_key_required" });
      // The point of catching it HERE: nothing was written and nothing was spent.
      expect(control.registerCalls).toEqual([]);
      expect(control.limits).toEqual([]);
    },
  );

  // NON-VACUITY for the block above: the check must not be refusing everything.
  it.each([
    ["a v4 UUID", "1c2f9a6e-5b3d-4f80-91a2-b3c4d5e6f708"],
    ["the same key in upper case", "1C2F9A6E-5B3D-4F80-91A2-B3C4D5E6F708"],
    // A v7 key is time-ordered and increasingly the default for exactly this
    // job. The column stores what Postgres accepts; pinning to v4 would refuse
    // a better key for no reason.
    ["a v7 UUID", "0192f0a1-6d2c-7c3e-8a4b-5f6071829304"],
    ["a key with surrounding whitespace", "  1c2f9a6e-5b3d-4f80-91a2-b3c4d5e6f708  "],
  ])("accepts %s", async (_label, key) => {
    const res = await POST(post(VALID_BODY, { idempotencyKey: key }));

    expect(res.status).toBe(201);
    expect(control.registerCalls[0]?.clientIdempotencyKey).toBe(key.trim());
  });

  it("refuses BEFORE spending a rate-limit counter", async () => {
    // The assertion is on ORDER, not presence. A client looping on a request it
    // has got structurally wrong must not be able to exhaust a shared per-IP
    // budget on behalf of every other subscriber behind the same CGNAT address.
    await POST(post(VALID_BODY, { idempotencyKey: null }));
    expect(control.limits).toEqual([]);
  });

  it("hands the key to registerPet as the client idempotency key", async () => {
    const key = randomUUID();
    await POST(post(VALID_BODY, { idempotencyKey: key }));

    expect(control.registerCalls).toHaveLength(1);
    expect(control.registerCalls[0].clientIdempotencyKey).toBe(key);
  });

  it("answers a REPLAY with 201, the first attempt's token, and wasDuplicate: true", async () => {
    control.register = () => ({
      ok: true,
      value: {
        petId: PET_ID,
        eventId: EVENT_ID,
        publicToken: "DIM-FIRST-0001",
        wasDuplicate: true,
      },
      notifications: [],
    });

    const res = await POST(post(VALID_BODY));

    // 201 and not 409: the caller asked for a pet to exist and a pet exists. A
    // retry forced by a subway tunnel is not an error state to render.
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ publicToken: "DIM-FIRST-0001", wasDuplicate: true });
  });

  // FB-4 — WHAT THIS LAYER CAN AND CANNOT PROVE, said out loud.
  //
  // The route mocks `registerPet` entirely, so "no second animal was created"
  // is not observable here: the use-case is where the decision lives, and
  // src/modules/pets/application/__tests__/register-pet.test.ts proves it
  // against a repository fake (insertPetRegistered never called on a hit).
  //
  // What IS the route's own and had never been asserted: that two attempts with
  // the SAME key are two identical pass-throughs. The route must not mutate,
  // regenerate or "helpfully" refresh the key between tries — a route that
  // handed attempt #2 a different key would defeat the whole mechanism, and
  // every existing assertion in this file would still have passed.
  it("passes the SAME key through on a retry, unchanged", async () => {
    const key = randomUUID();

    await POST(post(VALID_BODY, { idempotencyKey: key }));
    control.register = () => ({
      ok: true,
      value: {
        petId: PET_ID,
        eventId: EVENT_ID,
        publicToken: "DIM-FIRST-0001",
        wasDuplicate: true,
      },
      notifications: [],
    });
    const second = await POST(post(VALID_BODY, { idempotencyKey: key }));

    expect(control.registerCalls).toHaveLength(2);
    expect(control.registerCalls[0]?.clientIdempotencyKey).toBe(key);
    expect(control.registerCalls[1]?.clientIdempotencyKey).toBe(key);
    expect(await second.json()).toEqual({ publicToken: "DIM-FIRST-0001", wasDuplicate: true });
  });

  it("calls the use-case exactly ONCE per request, replay included", async () => {
    control.register = () => ({
      ok: true,
      value: {
        petId: PET_ID,
        eventId: EVENT_ID,
        publicToken: "DIM-FIRST-0001",
        wasDuplicate: true,
      },
      notifications: [],
    });

    await POST(post(VALID_BODY));

    // No internal retry loop, no double dispatch: one HTTP request, one attempt.
    expect(control.registerCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Authorization — the same mapping as /me
// ---------------------------------------------------------------------------

describe("POST /api/v1/pets — authorization", () => {
  it("answers auth_required when there is no Authorization header at all", async () => {
    const res = await POST(post(VALID_BODY, { bearer: null }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_required" });
  });

  it("answers auth_expired for a header that is not a usable bearer", async () => {
    const res = await POST(post(VALID_BODY, { bearer: "Basic abc" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "auth_expired" });
  });

  it.each([
    ["ACCOUNT_ERASED", 403, "account_erased"],
    ["DEACTIVATED", 403, "account_deactivated"],
    ["NO_SESSION", 401, "auth_expired"],
    ["MAINTENANCE", 503, "temporarily_unavailable"],
  ] as const)("maps %s to %i %s", async (reason, status, code) => {
    control.live = () => ({ ok: false, reason, supabase: null, user: null, error: "" });

    const res = await POST(post(VALID_BODY));

    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code });
  });

  it("refuses a DEACTIVATED account rather than tolerating it — this is a WRITE", async () => {
    // The repo's policy since the 2026-07-04 redirect incident is "reads stay
    // open so the user can see why; writes stop". This is the write.
    control.live = () => ({
      ok: false,
      reason: "DEACTIVATED",
      supabase: null,
      user: null,
      error: "",
    });
    const res = await POST(post(VALID_BODY));
    expect(res.status).toBe(403);
    expect(control.registerCalls).toEqual([]);
  });

  it("refuses an account whose IDENTITY was never completed, and registers nothing", async () => {
    // DEFENCE IN DEPTH, and the reason it is worth having: this system is an
    // identity registry, so a credential registered by an account still wearing
    // the `handle_new_user` trigger's email-derived name names a titular nobody
    // typed. The native gate (`useGate` → `identidad-pendiente`) and the web
    // `(app)` layout both stop somebody reaching this URL through a screen;
    // neither binds a bearer token addressing it directly.
    control.live = () => ({
      ok: true,
      supabase: {},
      user: { id: OWNER_ID, email: "ana.gomez@example.com" },
      // The provisional name: `split_part(email, '@', 1)`.
      profile: { displayName: "ana.gomez" },
    });

    const res = await POST(post(VALID_BODY));

    // 403 and its own code: the credential is valid (so not a 401 that invites
    // a refresh) and both caller and resource exist (so not a 404). The action
    // is "go and finish registering", which is neither of the other two.
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "identity_pending" });
    expect(control.registerCalls).toEqual([]);
  });

  it("registers normally once the identity IS complete", async () => {
    // The control that keeps the gate from being a blanket refusal. Same
    // request, same account, a real name instead of the provisional one.
    const res = await POST(post(VALID_BODY));

    expect(res.status).toBe(201);
    expect(control.registerCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

describe("POST /api/v1/pets — server-side gates", () => {
  it("refuses a breed that is not in the species catalog, and writes nothing", async () => {
    // QA A4, on the API. The catalog ships to clients now
    // (`@dim/contract/reference`) so a native picker renders offline — and that
    // changes nothing here. A misspelled PPP breed must not escape a LEGAL
    // regime because a client sent it anyway.
    const res = await POST(post({ ...VALID_BODY, breed: "Raza-Falsa-CW0813" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(control.registerCalls).toEqual([]);
  });

  it("accepts a colloquial breed and stores the CANONICAL catalog label", async () => {
    // "pitbull" is not a catalog entry; the curated alias table resolves it to
    // "Pit Bull Terrier". The server decides what a label means, so what lands
    // in the registry is the canonical one — this is the half of QA A4 that a
    // rejection test alone would not show.
    const res = await POST(post({ ...VALID_BODY, breed: "pitbull" }));

    expect(res.status).toBe(201);
    const parsed = control.registerCalls[0].parsed as { breed: string };
    expect(parsed.breed).toBe("Pit Bull Terrier");
  });

  it("refuses a locality the INDEC catalogue does not know", async () => {
    control.localityRejects = true;

    const res = await POST(post(VALID_BODY));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(control.registerCalls).toEqual([]);
  });

  it("refuses a suspected same-owner duplicate with 409, and writes nothing", async () => {
    control.duplicate = { publicToken: "DIM-EXIS-0001" };

    const res = await POST(post(VALID_BODY));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "duplicate_pet_suspected" });
    expect(control.registerCalls).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // A2-alta-asentar-04 — the retry the key exists for
  // -------------------------------------------------------------------------
  //
  // The client gives up after 10 s ("No pudimos conectarnos") while the server
  // commits. The person taps Registrar again; the request carries the SAME key.
  // The dedupe scan runs BEFORE `registerPet`, matched the pet the phone had
  // just created, and the app showed "Ya tenés registrada una mascota llamada
  // Pampa…" about it — with a "Cancelar" that sent the person away believing
  // nothing had been registered. The replay 201 was unreachable.
  it("answers a retry on the SAME key with the replay, not the duplicate dialog", async () => {
    const key = randomUUID();
    control.duplicate = { publicToken: "DIM-PAMP-0001" };
    control.duplicateRegistrationKey = key;
    control.register = () => ({
      ok: true,
      value: {
        petId: PET_ID,
        eventId: EVENT_ID,
        publicToken: "DIM-PAMP-0001",
        wasDuplicate: true,
      },
      notifications: [],
    });

    const res = await POST(post(VALID_BODY, { idempotencyKey: key }));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ publicToken: "DIM-PAMP-0001", wasDuplicate: true });
  });

  it("hands the request's Idempotency-Key to the dedupe scan", async () => {
    const key = randomUUID();

    await POST(post(VALID_BODY, { idempotencyKey: key }));

    expect(control.dedupeCalls).toHaveLength(1);
    expect(control.dedupeCalls[0].excludeClientIdempotencyKey).toBe(key);
  });

  // -------------------------------------------------------------------------
  // A2-alta-asentar-03 — which homonym
  // -------------------------------------------------------------------------
  //
  // The INDEC catalogue ships 68 (province, name) collisions, and the picker
  // disambiguates them by showing the DEPARTMENT. Sending only the name let the
  // server resolve with `.orderBy(departmentName).limit(1)`, so a person in San
  // Martín, Mendoza who tapped the right row got a pet in San Martín, Buenos
  // Aires. Jurisdiction decides the responding authority and the PPP regime.
  it("hands the locality's INDEC id to the normalizer when the client sends one", async () => {
    await POST(post({ ...VALID_BODY, localityIndecId: "500098" }));

    expect(control.normalizeCalls).toHaveLength(1);
    expect(control.normalizeCalls[0].localityIndecId).toBe("500098");
  });

  it("sends null for a body that omits it — an older build still registers", async () => {
    const res = await POST(post(VALID_BODY));

    expect(res.status).toBe(201);
    expect(control.normalizeCalls[0].localityIndecId).toBeNull();
  });

  it("still refuses a duplicate registered under a DIFFERENT key", async () => {
    // The exclusion is not a way past the gate: only the pet this attempt
    // itself created is skipped.
    control.duplicate = { publicToken: "DIM-EXIS-0001" };
    control.duplicateRegistrationKey = randomUUID();

    const res = await POST(post(VALID_BODY, { idempotencyKey: randomUUID() }));

    expect(res.status).toBe(409);
    expect(control.registerCalls).toEqual([]);
  });

  // FB-4 — `duplicateOverride` IS NOT A SKELETON KEY, and nothing pinned that.
  //
  // The property holds today because the breed gate runs before the pre-write
  // resolution that reads the flag; it holds by ORDERING, which is the kind of
  // guarantee a refactor deletes without noticing. `duplicateOverride` waives
  // exactly one SOFT data-quality gate ("¿es la misma?"), and a legal regime is
  // not a data-quality gate: a misspelled PPP breed must not reach the registry
  // because the caller happened to tick a box about a different question.
  it("does not let duplicateOverride carry a bad breed past the catalog gate", async () => {
    control.duplicate = { publicToken: "DIM-EXIS-0001" };

    const res = await POST(
      post({ ...VALID_BODY, breed: "Raza-Falsa-CW0813", duplicateOverride: true }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(control.registerCalls).toEqual([]);
  });

  // NON-VACUITY for the test above: the flag must actually DO its one job, or
  // "it did not bypass the breed gate" would be true of a flag that does
  // nothing at all.
  it("still lets duplicateOverride past the same-owner dedupe it is for", async () => {
    control.duplicate = { publicToken: "DIM-EXIS-0001" };

    const res = await POST(post({ ...VALID_BODY, duplicateOverride: true }));

    expect(res.status).toBe(201);
    expect(control.registerCalls).toHaveLength(1);
  });

  it("says NOTHING about which pet it matched", async () => {
    // The envelope is one key (§2). The client already holds the list from
    // GET /api/v1/me/pets and can name the pet itself; this response naming one
    // would put a second copy of that data on a wire for no gain.
    control.duplicate = { publicToken: "DIM-EXIS-0001" };
    const body = JSON.stringify(await (await POST(post(VALID_BODY))).json());
    expect(body).not.toContain("DIM-EXIS-0001");
  });

  it("lets duplicateOverride through — the gate is SOFT, as it is on the web", async () => {
    control.duplicate = { publicToken: "DIM-EXIS-0001" };

    const res = await POST(post({ ...VALID_BODY, duplicateOverride: true }));

    expect(res.status).toBe(201);
    expect(control.registerCalls).toHaveLength(1);
  });

  it("refuses an unresolvable province code", async () => {
    const res = await POST(post({ ...VALID_BODY, provinceCode: "AR-ZZZ" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  it("accepts the schema's OWN output as a body — blank optionals arrive as null", async () => {
    // What the native wizard actually sends: it parses its draft with
    // `registerPetInputSchema` and posts `parsed.data`, in which every optional
    // the person left blank is `null`. The first real registration from the
    // Play build (2026-09-05) was refused here with invalid_request because the
    // schema emitted `null` and did not accept it back.
    const wire = JSON.parse(
      JSON.stringify(
        registerPetInputSchema.parse({
          name: "Pampa",
          species: "dog",
          provinceCode: "AR-C",
          localityName: "Villa Crespo",
        }),
      ),
    );
    expect(wire).toMatchObject({
      breed: null,
      color: null,
      estimatedWeightKg: null,
      ageYears: null,
      ageMonths: null,
    });

    const res = await POST(post(wire));

    expect(res.status).toBe(201);
    expect(control.registerCalls).toHaveLength(1);
    // The nulls reached the use case as "not stated", not as a refusal upstream.
    expect(control.registerCalls[0]).toMatchObject({
      parsed: { breed: null, color: null, estimatedWeightKg: null },
    });
  });

  it.each([
    ["a body that is not JSON at all", "not json"],
    ["a body missing the name", JSON.stringify({ ...VALID_BODY, name: "" })],
    [
      "a species outside the accepted vocabulary",
      JSON.stringify({ ...VALID_BODY, species: "dinosaurio" }),
    ],
    ["a body with no locality", JSON.stringify({ ...VALID_BODY, localityName: "" })],
  ])("refuses %s with invalid_request", async (_label, body) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("POST /api/v1/pets — rate limiting", () => {
  it("spends the per-IP bucket keyed on the trusted caller IP", async () => {
    await POST(post(VALID_BODY));
    expect(control.limits[0]).toEqual({
      endpoint: "api_v1_pets_register_ip",
      identifier: "203.0.113.44",
    });
  });

  it("spends the per-USER bucket only after the caller is known", async () => {
    await POST(post(VALID_BODY));
    // Order is the assertion: there is no user id before the guard answers, and
    // an unauthenticated hammer must never write into the per-user keyspace.
    expect(control.limits.map((l) => l.endpoint)).toEqual([
      "api_v1_pets_register_ip",
      "api_v1_pets_register_user",
    ]);
    expect(control.limits[1].identifier).toBe(OWNER_ID);
  });

  it("answers 429 when a budget is exhausted, and writes nothing", async () => {
    control.limiterThrows = () => {
      throw new RateLimitError(new Date(), "test");
    };

    const res = await POST(post(VALID_BODY));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(control.registerCalls).toEqual([]);
  });

  it("FAILS OPEN when the limiter itself is broken", async () => {
    // The limiter is a DB write. If `rate_limit_buckets` is unavailable,
    // refusing here would stop every citizen in the country registering a pet
    // over an abuse control — while the authorization boundary stays intact and
    // fails CLOSED, which is the one that must.
    control.limiterThrows = () => {
      throw new Error("rate_limit_buckets is on fire");
    };

    const res = await POST(post(VALID_BODY));

    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// The wire shape
// ---------------------------------------------------------------------------

describe("POST /api/v1/pets — what a native client receives", () => {
  it("returns the public token and nothing else", async () => {
    const res = await POST(post(VALID_BODY));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ publicToken: "DIM-TEST-0001", wasDuplicate: false });
  });

  it("carries NO internal ids", async () => {
    // `registerPet` hands back a petId and an eventId. Neither may reach a wire
    // a device caches to disk: the publicToken IS the pet's identity everywhere
    // a client operates.
    const body = JSON.stringify(await (await POST(post(VALID_BODY))).json());
    expect(body).not.toContain(PET_ID);
    expect(body).not.toContain(EVENT_ID);
  });

  it("answers pet_registration_failed — never the use-case's prose — when the write fails", async () => {
    control.register = () => ({
      ok: false,
      error: "No se pudo crear la mascota: duplicate key value violates unique constraint",
    });

    const res = await POST(post(VALID_BODY));

    expect(res.status).toBe(500);
    // The failure arm is an untyped string carrying es-AR prose written for a
    // web form, and it can name internal constraints. It stays on our side.
    expect(await res.json()).toEqual({ error: "pet_registration_failed" });
  });

  it.each([
    ["success", async () => POST(post(VALID_BODY))],
    ["missing key", async () => POST(post(VALID_BODY, { idempotencyKey: null }))],
    ["no auth", async () => POST(post(VALID_BODY, { bearer: null }))],
    ["bad breed", async () => POST(post({ ...VALID_BODY, breed: "Raza-Falsa" }))],
    [
      "throttled",
      async () => {
        control.limiterThrows = () => {
          throw new RateLimitError(new Date(), "test");
        };
        return POST(post(VALID_BODY));
      },
    ],
  ])("sets cache-control: no-store on the %s branch", async (_label, run) => {
    // NOT inherited: middleware stamps it from a path-prefix allowlist `/api/…`
    // does not match. A test that checked only the happy path would certify
    // exactly the branch nobody forgets.
    const res = await run();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });
});
