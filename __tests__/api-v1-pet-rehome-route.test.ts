// `/api/v1/pets/{token}/rehome` — ACOMPAÑAMIENTO DE ADOPCIÓN: the read that
// says what is running and what this caller may do, and the three commands.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. THE GUARD IS THE LEGAL OWNER'S, on BOTH methods — narrower than every
//      sibling: a co-owner, a foster, a caretaker and the org path are refused
//      403 (they hold the animal; never 404), and the owner alone passes.
//   2. THE READ AND THE WRITE AGREE. The three capability flags come from one
//      derivation and the write refuses on the same one.
//   3. THE COMMANDS REACH THE WEB'S USE-CASES — the modules the fence joins on —
//      with the org resolved from its PUBLIC token, never an id off the wire.
//   4. THE `Idempotency-Key` IS REQUIRED FOR THE TWO WITHDRAWS, threaded to the
//      use-case, and its `replayed` answer reaches the ack. It is NOT read for
//      the ask.
//   5. EVERY REFUSAL IS MAPPED BY NAMED CONSTANT to the right status per WHOSE
//      fact it is; the unnamed remainder lands where the header says.
//   6. NOTHING IS WRITTEN when any gate refuses.
//
// The use-cases are MOCKED at the module the web action also imports (the
// parity claim); the real-Postgres proof of the ledger is
// `__tests__/rehome-withdraw-flow.test.ts`.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  NOT_TITULAR_ERROR,
  NO_ACTIVE_SPONSORSHIP_ERROR,
  NO_PENDING_REQUEST_ERROR,
  OPEN_REQUEST_PENDING_ERROR,
  OPEN_SPONSORSHIP_RUNNING_ERROR,
  ORG_NOT_VERIFIED_ERROR,
  PET_DECEASED_ERROR,
  PET_LOST_ERROR,
  REQUEST_ALREADY_ANSWERED_ERROR,
  REQUEST_NOT_SENDER_ERROR,
} from "@/src/modules/rehome/domain/rehome-rules";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PET_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "DIM-PAMP-0001";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const ORG_TOKEN = "DIM-ORG-0001";
const KEY = "4d5e6f70-8192-4a3b-9c4d-5e6f708192a3";

const control = vi.hoisted(() => ({
  live: null as null | (() => unknown),
  access: null as null | (() => unknown),
  /** What `getRehomeStateForPet` answers. */
  state: { kind: "none" } as Record<string, unknown>,
  /** What `listCoveringOrgs` answers. */
  orgs: [] as Array<Record<string, unknown>>,
  /** What `findOrgByPublicToken` answers. */
  org: null as null | Record<string, unknown>,
  requestResult: null as null | Record<string, unknown>,
  withdrawRequestResult: null as null | Record<string, unknown>,
  withdrawSponsorshipResult: null as null | Record<string, unknown>,
  /** Every use-case call. Empty means nothing was written. */
  writes: [] as Array<{ command: string; input: Record<string, unknown> }>,
  notified: [] as Array<Record<string, unknown>>,
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
  return { ...actual, enforceRateLimit: async () => {} };
});

vi.mock("@/lib/infra/pet-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/pet-access")>();
  return {
    ...actual,
    resolvePetHolderAccess: async () =>
      control.access ? control.access() : { kind: "owner", pet: petRow(), holderRole: "owner" },
  };
});

vi.mock("@/lib/supabase/bearer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/bearer")>();
  return {
    ...actual,
    createClientFromBearer: (header: string | null) =>
      header ? { ok: true, supabase: {}, token: "tok" } : { ok: false, reason: "MISSING" },
  };
});

vi.mock("@/src/modules/rehome/application/get-rehome-state-for-pet", () => ({
  getRehomeStateForPet: async () => control.state,
}));

vi.mock("@/src/modules/rehome/application/list-covering-orgs", () => ({
  listCoveringOrgs: async () => control.orgs,
}));

vi.mock("@/src/modules/rehome/infrastructure/rehome-repository", () => ({
  RehomeRepository: {
    findOrgByPublicToken: async () => control.org,
  },
}));

vi.mock("@/src/modules/rehome/application/request-rehome-sponsorship", () => ({
  requestRehomeSponsorship: async (input: Record<string, unknown>) => {
    control.writes.push({ command: "request_sponsorship", input });
    return control.requestResult;
  },
}));

vi.mock("@/src/modules/rehome/application/withdraw-rehome-request", () => ({
  withdrawRehomeRequest: async (input: Record<string, unknown>) => {
    control.writes.push({ command: "withdraw_request", input });
    return control.withdrawRequestResult;
  },
}));

vi.mock("@/src/modules/rehome/application/withdraw-rehome-sponsorship", () => ({
  withdrawRehomeSponsorship: async (input: Record<string, unknown>) => {
    control.writes.push({ command: "withdraw_sponsorship", input });
    return control.withdrawSponsorshipResult;
  },
}));

vi.mock("@/lib/infra/notification-service", () => ({
  createNotificationsBulk: async (rows: Array<Record<string, unknown>>) => {
    control.notified.push(...rows);
    return { created: rows.length, deadLettered: 0 };
  },
}));

import { GET, POST } from "@/app/api/v1/pets/[publicToken]/rehome/route";

function petRow(over: Record<string, unknown> = {}) {
  return {
    id: PET_ID,
    publicToken: TOKEN,
    name: "Pampa",
    species: "dog",
    status: "active",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    ...over,
  };
}

function read(headers: HeadersInit = { authorization: "Bearer t" }) {
  return GET(new Request(`https://x.test/api/v1/pets/${TOKEN}/rehome`, { headers }), {
    params: Promise.resolve({ publicToken: TOKEN }),
  });
}

function send(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request(`https://x.test/api/v1/pets/${TOKEN}/rehome`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ publicToken: TOKEN }) },
  );
}

const asRole = (holderRole: string) => () => ({ kind: "owner", pet: petRow(), holderRole });
const asOrg = () => () => ({
  kind: "org",
  pet: petRow(),
  organization: { id: ORG_ID },
  membership: {},
  eventAuthorship: { authorRole: "shelter", authorOrganizationId: ORG_ID, authorVerified: false },
});

const ASK = { command: "request_sponsorship", orgPublicToken: ORG_TOKEN };
const CANCEL = { command: "withdraw_request" };
const WITHDRAW = { command: "withdraw_sponsorship" };
const WITH_KEY = { "idempotency-key": KEY };

const ORG = {
  id: ORG_ID,
  displayName: "Refugio Padrino",
  publicToken: ORG_TOKEN,
  orgType: "shelter",
  verified: true,
};

beforeEach(() => {
  control.live = null;
  control.access = null;
  control.state = { kind: "none" };
  control.orgs = [
    {
      id: ORG_ID,
      publicToken: ORG_TOKEN,
      displayName: "Refugio Padrino",
      orgType: "shelter",
      locality: "La Plata",
    },
  ];
  control.org = ORG;
  control.requestResult = {
    ok: true,
    value: { caseId: "case-1", casePublicCode: "CAS-0001", orgDisplayName: "Refugio Padrino" },
    notifications: [{ userId: "coord-1", dedupeKey: "rehome:requested:case-1:coord-1" }],
  };
  control.withdrawRequestResult = {
    ok: true,
    value: {
      caseId: "case-1",
      casePublicCode: "CAS-0001",
      petId: PET_ID,
      petPublicToken: TOKEN,
      receiverOrganizationId: ORG_ID,
      replayed: false,
    },
    notifications: [],
  };
  control.withdrawSponsorshipResult = {
    ok: true,
    value: {
      petId: PET_ID,
      petPublicToken: TOKEN,
      sponsoringOrganizationId: ORG_ID,
      sponsoringOrganizationPublicToken: ORG_TOKEN,
      ownershipId: "own-1",
      listingCasePublicCode: "CAS-0002",
      custodyRowWasLive: true,
      replayed: false,
    },
    notifications: [],
  };
  control.writes = [];
  control.notified = [];
});

describe("GET — the titular's surface", () => {
  it("refuses without a bearer, and never says whether the pet exists", async () => {
    const response = await read({});
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "auth_required" });
  });

  it("answers 404 for a pet this caller may not reach — the same as one that does not exist", async () => {
    control.access = () => ({ kind: "none" });
    expect((await read()).status).toBe(404);
  });

  it("carries the three-state arrangement, the zone, the orgs by PUBLIC token, and the capabilities", async () => {
    const body = await (await read()).json();
    expect(body.payloadVersion).toBe(1);
    expect(body.petName).toBe("Pampa");
    expect(body.zone).toEqual({ province: "Buenos Aires", locality: "La Plata" });
    expect(body.state).toEqual({ kind: "none" });
    expect(body.orgs).toEqual([
      {
        publicToken: ORG_TOKEN,
        displayName: "Refugio Padrino",
        orgType: "shelter",
        locality: "La Plata",
      },
    ]);
    // NO INTERNAL IDs on the wire.
    expect(JSON.stringify(body)).not.toContain(ORG_ID);
    expect(body.capabilities).toEqual({
      canRequest: true,
      canWithdrawRequest: false,
      canWithdrawSponsorship: false,
    });
  });

  it("offers the cancel while pending, and the withdraw while active — never the ask", async () => {
    control.state = {
      kind: "pending",
      orgId: ORG_ID,
      orgDisplayName: "Refugio Padrino",
      casePublicCode: "CAS-0001",
    };
    let body = await (await read()).json();
    // NAMED FOR WHICH CASE: the payload carries the request case here and the
    // listing case on `active`, and never a bare `casePublicCode`.
    expect(body.state).toEqual({
      kind: "pending",
      orgDisplayName: "Refugio Padrino",
      requestCasePublicCode: "CAS-0001",
    });
    expect(body.capabilities).toEqual({
      canRequest: false,
      canWithdrawRequest: true,
      canWithdrawSponsorship: false,
    });

    control.state = {
      kind: "active",
      orgId: ORG_ID,
      orgDisplayName: "Refugio Padrino",
      orgPublicToken: ORG_TOKEN,
      listingCasePublicCode: "CAS-0002",
    };
    body = await (await read()).json();
    expect(body.state).toEqual({
      kind: "active",
      orgDisplayName: "Refugio Padrino",
      listingCasePublicCode: "CAS-0002",
    });
    expect(body.capabilities).toEqual({
      canRequest: false,
      canWithdrawRequest: false,
      canWithdrawSponsorship: true,
    });
  });

  it("withholds the ask on a lost or deceased animal — the domain's own rule, not a copy", async () => {
    for (const status of ["lost", "deceased"]) {
      control.access = () => ({ kind: "owner", pet: petRow({ status }), holderRole: "owner" });
      const body = await (await read()).json();
      expect(body.capabilities.canRequest).toBe(false);
    }
  });

  it("refuses a CO-OWNER, a FOSTER, a CARETAKER and the ORG path with 403 — they hold the animal", async () => {
    for (const access of [asRole("co_owner"), asRole("foster"), asRole("caretaker"), asOrg()]) {
      control.access = access;
      const response = await read();
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "rehome_forbidden" });
    }
  });

  it("sets cache-control: no-store", async () => {
    expect((await read()).headers.get("cache-control")).toContain("no-store");
  });
});

describe("POST — request_sponsorship", () => {
  it("resolves the org from its PUBLIC token and reaches the web's use-case with the id", async () => {
    const response = await send(ASK);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      command: "request_sponsorship",
      requestCasePublicCode: "CAS-0001",
      orgDisplayName: "Refugio Padrino",
    });
    expect(control.writes).toEqual([
      {
        command: "request_sponsorship",
        input: { petPublicToken: TOKEN, titularUserId: OWNER_ID, targetOrgId: ORG_ID },
      },
    ]);
    // The org's inbox notice went through the canonical service.
    expect(control.notified).toHaveLength(1);
  });

  it("takes no Idempotency-Key — sent or not, the ask is the same call", async () => {
    expect((await send(ASK, WITH_KEY)).status).toBe(200);
    expect((await send(ASK)).status).toBe(200);
    expect(control.writes).toHaveLength(2);
  });

  it("answers rehome_org_invalid for a token that resolves to nothing, writing nothing", async () => {
    control.org = null;
    const response = await send(ASK);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "rehome_org_invalid" });
    expect(control.writes).toHaveLength(0);
  });

  it("maps the use-case's named refusals to the code for WHOSE fact each is", async () => {
    const cases: Array<[string, number, string]> = [
      [NOT_TITULAR_ERROR, 403, "rehome_forbidden"],
      [PET_LOST_ERROR, 409, "rehome_not_allowed"],
      [PET_DECEASED_ERROR, 409, "rehome_not_allowed"],
      [OPEN_REQUEST_PENDING_ERROR, 409, "rehome_already_open"],
      [OPEN_SPONSORSHIP_RUNNING_ERROR, 409, "rehome_already_open"],
      [ORG_NOT_VERIFIED_ERROR, 400, "rehome_org_invalid"],
      ["Mascota no encontrada.", 404, "not_found"],
    ];
    for (const [error, status, code] of cases) {
      control.requestResult = { ok: false, error };
      const response = await send(ASK);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code });
    }
    expect(control.notified).toHaveLength(0);
  });

  it("lands the coverage rule's templated sentence on rehome_org_invalid — pick a different org", async () => {
    // MUTATION APPLIED: default the ask's unnamed remainder to rehome_failed.
    // Red — a person whose picker was stale would be told to retry an org
    // that will never cover their animal's zone.
    control.requestResult = {
      ok: false,
      error:
        "Refugio Lejano no cubre la zona de Pampa. Elegí una organización que trabaje en La Plata.",
    };
    const response = await send(ASK);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "rehome_org_invalid" });
  });

  it("refuses an empty org token at the schema", async () => {
    const response = await send({ command: "request_sponsorship", orgPublicToken: "  " });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(control.writes).toHaveLength(0);
  });
});

describe("POST — the two withdraws and their Idempotency-Key", () => {
  it("requires the header for withdraw_request, and answers idempotency_key_required without it", async () => {
    const response = await send(CANCEL);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "idempotency_key_required" });
    expect(control.writes).toHaveLength(0);
  });

  it("requires a UUID-shaped key for withdraw_sponsorship", async () => {
    const response = await send(WITHDRAW, { "idempotency-key": "not-a-uuid" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "idempotency_key_required" });
    expect(control.writes).toHaveLength(0);
  });

  it("threads the key to withdrawRehomeRequest and acks the case", async () => {
    const response = await send(CANCEL, WITH_KEY);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      command: "withdraw_request",
      requestCasePublicCode: "CAS-0001",
      replayed: false,
    });
    expect(control.writes).toEqual([
      {
        command: "withdraw_request",
        input: { petPublicToken: TOKEN, titularUserId: OWNER_ID, clientIdempotencyKey: KEY },
      },
    ]);
  });

  it("threads the key to withdrawRehomeSponsorship and acks the expediente and the org", async () => {
    const response = await send(WITHDRAW, WITH_KEY);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      command: "withdraw_sponsorship",
      listingCasePublicCode: "CAS-0002",
      orgPublicToken: ORG_TOKEN,
      replayed: false,
    });
    expect(control.writes[0].input.clientIdempotencyKey).toBe(KEY);
  });

  it("a replay the ledger recognised reaches the ack as replayed: true — a 200, never a refusal", async () => {
    control.withdrawSponsorshipResult = {
      ok: true,
      value: {
        petId: PET_ID,
        petPublicToken: TOKEN,
        sponsoringOrganizationId: ORG_ID,
        sponsoringOrganizationPublicToken: ORG_TOKEN,
        ownershipId: "own-1",
        listingCasePublicCode: null,
        custodyRowWasLive: false,
        replayed: true,
      },
      notifications: [],
    };
    const response = await send(WITHDRAW, WITH_KEY);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      command: "withdraw_sponsorship",
      listingCasePublicCode: null,
      orgPublicToken: ORG_TOKEN,
      replayed: true,
    });
  });

  it("maps the withdraws' named refusals, and lands the unnamed remainder on rehome_failed", async () => {
    const cases: Array<[string, number, string]> = [
      [NOT_TITULAR_ERROR, 403, "rehome_forbidden"],
      [REQUEST_NOT_SENDER_ERROR, 403, "rehome_forbidden"],
      [NO_PENDING_REQUEST_ERROR, 409, "rehome_nothing_to_withdraw"],
      [REQUEST_ALREADY_ANSWERED_ERROR, 409, "rehome_nothing_to_withdraw"],
      ["La solicitud no tiene una organización destinataria.", 500, "rehome_failed"],
    ];
    for (const [error, status, code] of cases) {
      control.withdrawRequestResult = { ok: false, error };
      const response = await send(CANCEL, WITH_KEY);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code });
    }
    control.withdrawSponsorshipResult = { ok: false, error: NO_ACTIVE_SPONSORSHIP_ERROR };
    const response = await send(WITHDRAW, WITH_KEY);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "rehome_nothing_to_withdraw" });
  });
});

describe("POST — the guard, before any command", () => {
  it("refuses a CO-OWNER, a FOSTER, a CARETAKER and the ORG path with 403, writing nothing", async () => {
    for (const access of [asRole("co_owner"), asRole("foster"), asRole("caretaker"), asOrg()]) {
      control.access = access;
      for (const body of [ASK, CANCEL, WITHDRAW]) {
        const response = await send(body, WITH_KEY);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "rehome_forbidden" });
      }
    }
    expect(control.writes).toHaveLength(0);
  });

  it("answers 404 for a pet this caller may not touch, before reading the command", async () => {
    control.access = () => ({ kind: "none" });
    expect((await send(ASK)).status).toBe(404);
    expect(control.writes).toHaveLength(0);
  });

  it("refuses an unknown command", async () => {
    const response = await send({ command: "adopt" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });

  it("answers 503 with a retry-after during MAINTENANCE, on both methods", async () => {
    control.live = () => ({ ok: false, reason: "MAINTENANCE" });
    for (const response of [await read(), await send(ASK)]) {
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
    }
    expect(control.writes).toHaveLength(0);
  });
});
