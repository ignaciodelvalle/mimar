// `POST /api/v1/pets/{token}/move` — MUDANZA, the bearer door.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. THE GUARD IS THE WEB'S, AND IT IS A DENY AND NOT AN ALLOW-LIST. A
//      person-path CARETAKER is the only holder refused; co-owner, foster and
//      the ORG path all pass, because that is what `requireTitularAccess`
//      admits on the browser. A narrower rule here would look safer and would
//      be a capability the app removes from people who have it on the web.
//   2. A REFUSED CALLER WRITES NOTHING. Every refusal arm is asserted against
//      an empty write log, not only against a status.
//   3. ART. 16 (Ley 25.326) CLOSES THIS DOOR TOO. An erased animal is what
//      `resolvePetHolderAccess` answers `{ kind: "none" }` for — both of its
//      paths filter `isNull(pets.deletedAt)` — and this door 404s it exactly as
//      it 404s a stranger's token. This route opens NO second read of `pets`, so
//      there is no second place for that predicate to be forgotten; the resolver
//      itself is fenced against the real erasure RPC in
//      `__tests__/public-soft-delete-resolution.test.ts`.
//   4. THE EVENT IS SIGNED BY THE DOOR, correctly per path: `OWNER_AUTHORSHIP`
//      on the person path, and the org's own computed authorship on the org one.
//      A native write that re-declared it could sign itself `authorVerified`.
//   5. THE ACK CARRIES THE CANONICAL JURISDICTION, not the request's.
//   6. THE THREE DOMAIN REFUSALS MAP TO THREE DIFFERENT STATUSES, because the
//      three moves a client must make are different: 400 fix the address, 409
//      nothing to do, 500 retry.
//   7. THE LIMITER FAILS OPEN AND THE GUARD STILL FAILS CLOSED. Asserted as a
//      PAIR, because the argument only works as one — a fail-open limiter that
//      carried the guard open with it would be one line doing two jobs.
//   8. EVERY LIVENESS ARM IS A REAL PATH, including the DEACTIVATED refusal
//      that is deliberately stricter than the web.

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PET_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "DIM-PAMP-0001";

const control = vi.hoisted(() => ({
  live: null as null | (() => unknown),
  access: null as null | (() => unknown),
  /** Every `recordJurisdictionMove` call. Empty means nothing was written. */
  writes: [] as Array<Record<string, unknown>>,
  /** What the use-case answers. */
  moveResult: {
    ok: true,
    eventId: "evt-1",
    province: "Río Negro",
    locality: "San Carlos de Bariloche",
  } as Record<string, unknown>,
  /** When set, the use-case throws instead of answering. */
  moveThrows: null as null | (() => never),
  /** When set, the limiter throws a NON-RateLimitError (infrastructure fault). */
  limiterThrows: false,
  /** When set, the limiter refuses with a real RateLimitError. */
  limiterRefuses: false,
}));

vi.mock("@/lib/infra/live-user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/live-user")>();
  return {
    ...actual,
    requireLiveUser: async () =>
      control.live
        ? control.live()
        : { ok: true, supabase: {}, user: { id: OWNER_ID }, profile: null },
  };
});

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: async (endpoint: string) => {
      if (control.limiterRefuses) {
        throw new actual.RateLimitError(new Date("2026-08-30T15:05:00.000Z"), endpoint);
      }
      if (control.limiterThrows) {
        // PRODUCTION'S OWN MESSAGE SHAPE, not a tidier one. `enforceRateLimit`
        // throws `UPSERT returned no rows for key "<bucket>:<id>:<window>"` on
        // its driver-glitch path, and a stub that threw something prettier is
        // the defect the denuncia lane found one file over: it makes the whole
        // file assert that the message does not matter.
        throw new Error(`UPSERT returned no rows for key "${endpoint}:${OWNER_ID}:hour:0"`);
      }
    },
  };
});

vi.mock("@/lib/infra/pet-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/pet-access")>();
  return {
    ...actual,
    resolvePetHolderAccess: async () =>
      control.access ? control.access() : { kind: "owner", pet: petRow(), holderRole: "owner" },
  };
});

vi.mock("@/src/modules/pets/application/movement/record-jurisdiction-move", () => ({
  recordJurisdictionMove: async (input: Record<string, unknown>) => {
    control.writes.push(input);
    if (control.moveThrows) control.moveThrows();
    return control.moveResult;
  },
}));

vi.mock("@/lib/supabase/bearer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/bearer")>();
  return {
    ...actual,
    createClientFromBearer: (header: string | null) =>
      header ? { ok: true, supabase: {}, token: "tok" } : { ok: false, reason: "MISSING" },
  };
});

import { POST } from "@/app/api/v1/pets/[publicToken]/move/route";
import { OWNER_AUTHORSHIP } from "@/lib/infra/pet-access";

function petRow(over: Record<string, unknown> = {}) {
  return {
    id: PET_ID,
    publicToken: TOKEN,
    name: "Pampa",
    jurisdictionCountry: "AR",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    status: "active",
    ...over,
  };
}

const ORG_AUTHORSHIP = {
  authorRole: "shelter" as const,
  authorOrganizationId: ORG_ID,
  authorVerified: false,
};

const VALID = { command: "record_move", provinceCode: "AR-R", localityName: "bariloche" };

function send(body: unknown, headers: HeadersInit = { authorization: "Bearer t" }) {
  return POST(
    new Request("https://x.test/api/v1/pets/DIM-PAMP-0001/move", {
      method: "POST",
      headers: { ...(headers as Record<string, string>), "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ publicToken: TOKEN }) },
  );
}

async function statusAndCode(res: Response) {
  const body = (await res.json()) as { error?: string };
  return { status: res.status, code: body.error };
}

beforeEach(() => {
  control.live = null;
  control.access = null;
  control.writes = [];
  control.moveResult = {
    ok: true,
    eventId: "evt-1",
    province: "Río Negro",
    locality: "San Carlos de Bariloche",
  };
  control.moveThrows = null;
  control.limiterThrows = false;
  control.limiterRefuses = false;
});

describe("POST /pets/{token}/move — WHO may move an animal", () => {
  it("admits the titular and answers the CANONICAL jurisdiction", async () => {
    const res = await send(VALID);
    expect(res.status).toBe(200);
    // MUTATION APPLIED: `jurisdiction: { province: input.provinceCode, locality:
    // input.localityName }`. Red — and a client rendering it would tell somebody
    // their animal is registered in "bariloche, AR-R", which is not a place.
    expect(await res.json()).toEqual({
      command: "record_move",
      eventId: "evt-1",
      jurisdiction: { province: "Río Negro", locality: "San Carlos de Bariloche" },
    });
    // No-store on every response — the helper's job, asserted here because this
    // route is the newest caller of it.
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it.each([["co_owner"], ["foster"]])(
    "admits a person-path %s, because the web's guard does",
    async (role) => {
      // MUTATION APPLIED: replace `isTitularHolder(...)` with an allow-list
      // `holderRole === "owner"`. Red for both roles — and the failure it
      // prevents is the app quietly removing a capability a foster HAS on the
      // browser. `isTitularHolder`'s own docblock: "A DENY and not an
      // allow-list … an allow-list silently narrows the roles the web admits."
      control.access = () => ({ kind: "owner", pet: petRow(), holderRole: role });
      const res = await send(VALID);
      expect(res.status).toBe(200);
      expect(control.writes).toHaveLength(1);
    },
  );

  it("refuses a person-path CARETAKER with 403 move_forbidden and writes nothing", async () => {
    // MUTATION APPLIED: `if (false)` on the titular check. Red.
    // MUTATION APPLIED: answer `not_found` here instead. Red — and the reason it
    // must not is `PetAccessFailureReason`'s own: "pretending the pet does not
    // exist to someone who is legitimately caring for it is a lie the UI cannot
    // recover from."
    control.access = () => ({ kind: "owner", pet: petRow(), holderRole: "caretaker" });
    expect(await statusAndCode(await send(VALID))).toEqual({
      status: 403,
      code: "move_forbidden",
    });
    expect(control.writes).toEqual([]);
  });

  it("admits the ORG path and signs the event with the ORG's authorship", async () => {
    // TWO ASSERTIONS IN ONE CASE ON PURPOSE: the org path passes BECAUSE
    // `holderRole` is null there, and what it signs with is the only thing that
    // distinguishes it from the person path once it has.
    // MUTATION APPLIED: `eventAuthorship: OWNER_AUTHORSHIP` unconditionally.
    // Red here, green on every person-path case — which is exactly the shape a
    // hardcoded signature has.
    control.access = () => ({
      kind: "org",
      pet: petRow(),
      organization: { id: ORG_ID },
      membership: { id: "m-1" },
      eventAuthorship: ORG_AUTHORSHIP,
    });
    const res = await send(VALID);
    expect(res.status).toBe(200);
    expect(control.writes[0].eventAuthorship).toEqual(ORG_AUTHORSHIP);
  });

  it("signs a person-path write with OWNER_AUTHORSHIP, not a re-declared literal", async () => {
    await send(VALID);
    expect(control.writes[0].eventAuthorship).toBe(OWNER_AUTHORSHIP);
    expect(control.writes[0].recordedByUserId).toBe(OWNER_ID);
  });

  it("answers 404 for a token this caller may not see — erased or stranger's alike", async () => {
    // `{ kind: "none" }` is what `resolvePetHolderAccess` returns BOTH for an
    // animal nobody told this caller about AND for a soft-deleted one, because
    // both of its paths filter `isNull(pets.deletedAt)`. Under PO-4 the two are
    // the same answer, and this door must not be the one that separates them.
    // MUTATION APPLIED: answer 403 `move_forbidden` for `kind: "none"`. Red —
    // and it would turn this URL into an oracle for which tokens are real.
    control.access = () => ({ kind: "none" });
    expect(await statusAndCode(await send(VALID))).toEqual({ status: 404, code: "not_found" });
    expect(control.writes).toEqual([]);
  });
});

describe("POST /pets/{token}/move — the three domain refusals", () => {
  it("maps `destination_invalid` to 400", async () => {
    control.moveResult = { ok: false, code: "destination_invalid", error: "no está" };
    expect(await statusAndCode(await send(VALID))).toEqual({
      status: 400,
      code: "move_destination_invalid",
    });
  });

  it("maps `same_locality` to 409 and NOT to 400", async () => {
    // MUTATION APPLIED: 400. Red. Nothing about the request is malformed — the
    // person picked a real place and it is the one the animal already lives in,
    // so a 400 would tell a client to fix a payload that is correct.
    control.moveResult = { ok: false, code: "same_locality", error: "igual" };
    expect(await statusAndCode(await send(VALID))).toEqual({
      status: 409,
      code: "move_same_locality",
    });
  });

  it("maps `write_failed` to 500 and does NOT echo the writer's sentence", async () => {
    control.moveResult = {
      ok: false,
      code: "write_failed",
      error: "connection terminated unexpectedly",
    };
    const res = await send(VALID);
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body).toEqual({ error: "move_failed" });
  });

  it("answers 500 rather than `destination_invalid` when the CATALOG READ throws", async () => {
    // THE DISTINCTION THIS CASE EXISTS FOR: the catalog lookup is a database
    // read, and a pooler outage is not "esa localidad no existe". Folding the
    // two would send somebody hunting for a spelling mistake in a town that is
    // spelled correctly — the same failure the denuncia lane refused when it
    // chose 503 over an empty result list for a geocoder outage.
    // MUTATION APPLIED: replace the catch body with a bare `throw err`. Red —
    // the handler rejects and no `{ error }` envelope ever forms, which is the
    // shape `adoption_application_failed` was minted to close on the door one
    // over ("a transaction that throws propagated out of the handler and Next
    // answered with something that is not the one-key envelope").
    control.moveThrows = () => {
      throw new Error("connection terminated unexpectedly");
    };
    expect(await statusAndCode(await send(VALID))).toEqual({ status: 500, code: "move_failed" });
  });
});

describe("POST /pets/{token}/move — the request envelope", () => {
  it("answers 401 auth_required with no Authorization header, before any budget", async () => {
    // The header regex runs FIRST, deliberately: a request with no parseable
    // bearer never reaches the limiter and never costs a GoTrue round-trip.
    expect(await statusAndCode(await send(VALID, {}))).toEqual({
      status: 401,
      code: "auth_required",
    });
    expect(control.writes).toEqual([]);
  });

  it.each([
    [{ command: "record_move", provinceCode: "", localityName: "Bariloche" }],
    [{ command: "record_move", provinceCode: "AR-R", localityName: "   " }],
    [{ command: "record_move", provinceCode: "AR-R" }],
    [{ command: "record_travel", provinceCode: "AR-R", localityName: "Bariloche" }],
    [{ provinceCode: "AR-R", localityName: "Bariloche" }],
  ])("answers 400 invalid_request for %j and writes nothing", async (body) => {
    // THE BLANK-PROVINCE CASE IS THE LOAD-BEARING ONE. A blank province reaches
    // `canonicalProvinceNameForStorage("")`, which returns null, which makes the
    // STRICT branch of the normalizer skip the catalog entirely — so without
    // this schema a request with no province writes an uncanonicalized pair and
    // reports success.
    // MUTATION APPLIED: `.min(1)` → `.min(0)` on both destination fields. Red on
    // the first two rows.
    expect(await statusAndCode(await send(body))).toEqual({
      status: 400,
      code: "invalid_request",
    });
    expect(control.writes).toEqual([]);
  });

  it("answers 400 for a body that is not JSON at all", async () => {
    expect(await statusAndCode(await send("{not json"))).toEqual({
      status: 400,
      code: "invalid_request",
    });
  });

  it("accepts a null reason and passes it through as null", async () => {
    await send({ ...VALID, reason: null });
    expect(control.writes[0].reason).toBeNull();
  });

  it("refuses a reason past the cap rather than truncating it", async () => {
    // Truncation would edit somebody's explanation without being asked — the
    // argument `petIdentityFieldCap` makes about a pre-filled `TextInput`, in
    // the other direction.
    expect(await statusAndCode(await send({ ...VALID, reason: "x".repeat(201) }))).toEqual({
      status: 400,
      code: "invalid_request",
    });
    expect(control.writes).toEqual([]);
  });
});

describe("POST /pets/{token}/move — liveness, and the limiter's two directions", () => {
  it.each([
    ["NO_SESSION", 401, "auth_expired"],
    ["ACCOUNT_ERASED", 403, "account_erased"],
    ["DEACTIVATED", 403, "account_deactivated"],
    ["SHIFT_EXPIRED", 401, "session_shift_expired"],
    ["MAINTENANCE", 503, "temporarily_unavailable"],
  ])("refuses %s with %i and writes nothing", async (reason, status, code) => {
    // DEACTIVATED IS THE ONE THAT IS A DECISION. `requireUserOrRedirect` passes a
    // deactivated account on purpose, so the browser's mudanza page serves one
    // and this door does not. It is pinned here so it stays a decision rather
    // than becoming drift — the same divergence `me/pet-claims` records.
    control.live = () => ({ ok: false, reason, supabase: {}, user: null, error: "no" });
    expect(await statusAndCode(await send(VALID))).toEqual({ status, code });
    expect(control.writes).toEqual([]);
  });

  it("answers 429 when the limiter genuinely refuses", async () => {
    control.limiterRefuses = true;
    expect(await statusAndCode(await send(VALID))).toEqual({ status: 429, code: "rate_limited" });
    expect(control.writes).toEqual([]);
  });

  it("FAILS OPEN when the limiter's own storage is broken", async () => {
    // MUTATION APPLIED: `return false` in `spendBudget`'s catch. Red — and a
    // limiter outage would then stop an owner recording where their animal lives
    // over an abuse control.
    control.limiterThrows = true;
    const res = await send(VALID);
    expect(res.status).toBe(200);
    expect(control.writes).toHaveLength(1);
  });

  it("keeps the AUTHORIZATION guard CLOSED while the limiter is broken", async () => {
    // THE PAIR, and the argument only works as one. `me/appointments` had the
    // fail-open case and not this one; a fail-open limiter that carried the
    // guard open with it would be a single line doing two jobs, and the first
    // half would look correct on its own.
    // MUTATION APPLIED: `return true` from the whole of `runPetMoveCommand`'s
    // titular check while `limiterThrows` is set. Red.
    control.limiterThrows = true;
    control.access = () => ({ kind: "owner", pet: petRow(), holderRole: "caretaker" });
    expect(await statusAndCode(await send(VALID))).toEqual({
      status: 403,
      code: "move_forbidden",
    });
    expect(control.writes).toEqual([]);
  });
});
