// `POST /api/v1/pets/{token}/events/{eventId}/amend` — correcting a record.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. THE SERVER SUPPLIES `old`. The wire carries only the NEW value; the
//      previous one is read out of the CORRECTED record inside the request. A
//      client-supplied `old` would be a claim about the server's own state, and
//      the value that reaches the spine must come from the record — including
//      when an earlier correction already moved that field.
//   2. `Idempotency-Key` IS HONOURED, not merely demanded. A required header the
//      writer discards would tell a client it is protected when it is not.
//   3. THE REFUSALS ARE THE WEB'S RULE, in the web's ORDER, with the right
//      status per code: 403 for a fact about the CALLER, 409 for a fact about
//      the RECORD, 400 for a malformed envelope, 404 for anything a caller may
//      not see.
//   4. A REPLAY IS A SUCCESS, and it says so.
//   5. Nothing is written when any gate refuses.

import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  live: null as null | (() => unknown),
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  access: null as null | (() => unknown),
  read: null as null | (() => unknown),
  capabilities: new Set<string>(["event.write"]),
  /** Every call the writer received. Empty means nothing was written. */
  writes: [] as Array<Record<string, unknown>>,
  writeResult: null as null | (() => unknown),
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
    enforceRateLimit: async (endpoint: string, identifier: string) => {
      control.limits.push({ endpoint, identifier });
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

vi.mock("@/src/modules/organizations/infrastructure/authz-resolver", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/src/modules/organizations/infrastructure/authz-resolver")
    >();
  return { ...actual, getGrantedCapabilities: async () => control.capabilities };
});

vi.mock("@/src/modules/events/application/read/load-pet-event-detail", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/src/modules/events/application/read/load-pet-event-detail")
    >();
  return {
    ...actual,
    loadPetEventDetail: async () => (control.read ? control.read() : detailRead()),
  };
});

vi.mock("@/src/modules/events/application/amendment/amend-event", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/src/modules/events/application/amendment/amend-event")>();
  return {
    ...actual,
    amendEvent: async (
      user: { id: string },
      pet: { id: string },
      authorship: unknown,
      input: Record<string, unknown>,
    ) => {
      control.writes.push({ user, pet, authorship, input });
      return control.writeResult
        ? control.writeResult()
        : { ok: true, amendmentEventId: AMEND_ID, wasDuplicate: false };
    },
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

import type { EventAmendedV1 } from "@dim/contract/api";

import { POST } from "@/app/api/v1/pets/[publicToken]/events/[eventId]/amend/route";
import type { PetEventDetailRead } from "@/src/modules/events/application/read/load-pet-event-detail";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PET_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const AMEND_ID = "44444444-4444-4444-8444-444444444444";
const KEY = "55555555-5555-4555-8555-555555555555";
const TOKEN = "DIM-PAMP-0001";

function petRow(overrides: Record<string, unknown> = {}) {
  return { id: PET_ID, publicToken: TOKEN, name: "Pampa", status: "active", ...overrides };
}

function detailRead(overrides: Partial<PetEventDetailRead> = {}): PetEventDetailRead {
  return {
    id: EVENT_ID,
    eventType: "vaccination_administered",
    // The CORRECTED state — this is what `old` must be read from.
    payload: { vaccine_name: "Antirrábica", batch: "L-42" },
    originalPayload: { vaccine_name: "Antirabica", batch: "L-42" },
    occurredAt: new Date("2026-08-20T12:00:00Z"),
    recordedAt: new Date("2026-08-21T09:00:00Z"),
    notes: null,
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    authorOrgName: null,
    recordedByUserId: OWNER_ID,
    locationLat: null,
    locationLng: null,
    amendments: [],
    attachments: [],
    ...overrides,
  };
}

async function call(
  body: unknown = { reason: null, changes: [{ field: "batch", value: "L-99" }] },
  init: { key?: string | null; eventId?: string; authorization?: string | null } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = init.authorization === undefined ? "Bearer tok" : init.authorization;
  if (auth) headers.authorization = auth;
  const key = init.key === undefined ? KEY : init.key;
  if (key) headers["idempotency-key"] = key;
  const eventId = init.eventId ?? EVENT_ID;
  return POST(
    new Request(`https://www.mimar.com.ar/api/v1/pets/${TOKEN}/events/${eventId}/amend`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ publicToken: TOKEN, eventId }) },
  );
}

beforeEach(() => {
  control.live = null;
  control.limits = [];
  control.access = null;
  control.read = null;
  control.capabilities = new Set(["event.write"]);
  control.writes = [];
  control.writeResult = null;
});

describe("POST .../amend — what reaches the spine", () => {
  it("fills `old` from the record and takes `new` from the wire", async () => {
    const response = await call({
      reason: "Lote mal cargado",
      changes: [{ field: "batch", value: "L-99" }],
    });
    expect(response.status).toBe(201);
    expect(control.writes).toHaveLength(1);
    const input = control.writes[0]?.input as Record<string, unknown>;
    expect(input.changes).toEqual([{ field: "batch", old: "L-42", new: "L-99" }]);
    expect(input.reason).toBe("Lote mal cargado");
  });

  it("reads `old` from the CORRECTED state, not from the row as first written", async () => {
    // The record was already corrected once: `vaccine_name` reads "Antirrábica"
    // now and "Antirabica" in the original. A correction on top of a correction
    // must record what it actually replaced.
    const response = await call({
      reason: null,
      changes: [{ field: "vaccine_name", value: "Antirrábica trivalente" }],
    });
    expect(response.status).toBe(201);
    const input = control.writes[0]?.input as Record<string, unknown>;
    expect(input.changes).toEqual([
      { field: "vaccine_name", old: "Antirrábica", new: "Antirrábica trivalente" },
    ]);
  });

  it("passes the caller's Idempotency-Key THROUGH, rather than demanding and dropping it", async () => {
    await call();
    const input = control.writes[0]?.input as Record<string, unknown>;
    expect(input.clientIdempotencyKey).toBe(KEY);
  });

  it("signs a person-path correction as the owner, never as a verified professional", async () => {
    await call();
    expect(control.writes[0]?.authorship).toEqual({
      authorRole: "owner",
      authorOrganizationId: null,
      authorVerified: false,
    });
  });

  it("signs an org-path correction with the membership's resolved authorship", async () => {
    const eventAuthorship = {
      authorRole: "vet",
      authorOrganizationId: "org-1",
      authorVerified: true,
    };
    control.access = () => ({
      kind: "org",
      pet: petRow(),
      organization: { id: "org-1" },
      membership: { id: "m-1" },
      eventAuthorship,
    });
    await call();
    expect(control.writes[0]?.authorship).toEqual(eventAuthorship);
  });

  it("answers 201 with wasDuplicate on a replay — the caller asked for a correction and one exists", async () => {
    control.writeResult = () => ({ ok: true, amendmentEventId: AMEND_ID, wasDuplicate: true });
    const response = await call();
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual<EventAmendedV1>({
      amendmentEventId: AMEND_ID,
      wasDuplicate: true,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("POST .../amend — the refusals", () => {
  it("refuses a missing or malformed key with ONE envelope code, before any counter", async () => {
    for (const key of [null, "not-a-uuid"]) {
      control.limits = [];
      const response = await call(undefined, { key });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "idempotency_key_required" });
      expect(control.limits).toEqual([]);
      expect(control.writes).toEqual([]);
    }
  });

  it("refuses a body the contract schema rejects, without field detail", async () => {
    // No changes at all: a correction that changes nothing is not a correction.
    const response = await call({ reason: null, changes: [] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(control.writes).toEqual([]);
  });

  it("refuses a field the record does not carry", async () => {
    // The web form can only offer keys the payload already has.
    const response = await call({
      reason: null,
      changes: [{ field: "inventado", value: "x" }],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(control.writes).toEqual([]);
  });

  it("refuses a key the correction machinery owns", async () => {
    // `payload_version` decides the payload's SHAPE; correcting it would hand
    // every later reader a mis-shaped record. The contract schema refuses it, so
    // this never reaches the field check.
    const response = await call({
      reason: null,
      changes: [{ field: "payload_version", value: "9" }],
    });
    expect(response.status).toBe(400);
    expect(control.writes).toEqual([]);
  });

  it("answers 404 for a pet the caller may not touch, identically to one that does not exist", async () => {
    control.access = () => ({ kind: "none" });
    const response = await call();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(control.writes).toEqual([]);
  });

  it("answers 404 for a malformed event id", async () => {
    const response = await call(undefined, { eventId: "not-a-uuid" });
    expect(response.status).toBe(404);
    expect(control.writes).toEqual([]);
  });

  it("answers 404 for an event of ANOTHER animal", async () => {
    control.read = () => null;
    const response = await call();
    expect(response.status).toBe(404);
    expect(control.writes).toEqual([]);
  });

  it("answers 409 for a DECEASED animal — a fact about the animal, not the caller", async () => {
    control.access = () => ({
      kind: "owner",
      pet: petRow({ status: "deceased" }),
      holderRole: "owner",
    });
    const response = await call();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "amend_not_allowed" });
    expect(control.writes).toEqual([]);
  });

  it("answers 409 for a type outside the allowlist", async () => {
    // `death_recorded` is forensic and has no reversal path.
    control.read = () => detailRead({ eventType: "death_recorded", payload: { batch: "x" } });
    const response = await call();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "amend_not_allowed" });
    expect(control.writes).toEqual([]);
  });

  it("answers 403 for an org member without event.write — a fact about the CALLER", async () => {
    control.capabilities = new Set();
    control.access = () => ({
      kind: "org",
      pet: petRow(),
      organization: { id: "org-1" },
      membership: { id: "m-1" },
      eventAuthorship: {
        authorRole: "shelter",
        authorOrganizationId: "org-1",
        authorVerified: false,
      },
    });
    const response = await call();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "amend_forbidden" });
    expect(control.writes).toEqual([]);
  });

  it("ADMITS an org member WITH event.write, mirroring the web's own guard", async () => {
    // The web's server action allows this path; narrowing here would only make
    // the two doors disagree about a surface that is already reachable.
    control.access = () => ({
      kind: "org",
      pet: petRow(),
      organization: { id: "org-1" },
      membership: { id: "m-1" },
      eventAuthorship: {
        authorRole: "shelter",
        authorOrganizationId: "org-1",
        authorVerified: false,
      },
    });
    const response = await call();
    expect(response.status).toBe(201);
  });

  it("maps a failed transaction to a retryable code, without leaking its prose", async () => {
    control.writeResult = () => ({
      ok: false,
      code: "write_failed",
      error: "Error al guardar la enmienda. Intentá de nuevo.",
    });
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "amend_failed" });
  });

  // FI-7. Every one of these WAS `amend_failed` 500 — a code whose documented
  // advice is "retry once with the same key", given to refusals that will answer
  // the retry identically forever. The prose still never reaches the wire.
  it("answers 400 for the administrative reason minimum, not a retryable 500", async () => {
    // D5: an `admin` or `govt` profile must state a reason. The wire schema
    // cannot know this — the rule is about WHO is asking — so the refusal can
    // only come back from the write, and it has to come back as a caller error.
    control.writeResult = () => ({
      ok: false,
      code: "reason_required",
      error:
        "El motivo es obligatorio para enmiendas de administrador/gobierno (mínimo 5 caracteres).",
    });
    const response = await call();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "amend_reason_required" });
  });

  it("answers 409 when the record turns out not to be amendable at write time", async () => {
    control.writeResult = () => ({
      ok: false,
      code: "not_amendable",
      error: 'El tipo de evento "death_recorded" no admite enmiendas.',
    });
    const response = await call();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "amend_not_allowed" });
  });

  it("answers 409 when the record's AUTHORSHIP refuses this caller (PO decision 3B)", async () => {
    // The use-case owns the rule, so this door inherits it; what the route owns
    // is the mapping — a code every installed native build already switches on,
    // and never the es-AR prose.
    control.writeResult = () => ({
      ok: false,
      code: "authorship_refused",
      error:
        "Este registro lo cargó o lo corrigió un profesional. Solo un profesional puede corregirlo.",
    });
    const response = await call();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "amend_not_allowed" });
  });

  it("answers 404 when the target vanished between the read and the write", async () => {
    control.writeResult = () => ({
      ok: false,
      code: "target_not_found",
      error: "Evento no encontrado.",
    });
    const response = await call();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("answers 400, not 500, for a correction the use-case says changes nothing", async () => {
    control.writeResult = () => ({
      ok: false,
      code: "changes_required",
      error: "Debés indicar al menos un cambio.",
    });
    const response = await call();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });

  it("spends its own buckets, tighter than a read's", async () => {
    await call();
    expect(control.limits).toEqual([
      { endpoint: "api_v1_amend_ip", identifier: expect.any(String) },
      { endpoint: "api_v1_amend_user", identifier: OWNER_ID },
    ]);
  });

  it("answers 401 without a bearer, and never writes a counter for it", async () => {
    const response = await call(undefined, { authorization: null });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "auth_required" });
    expect(control.limits).toEqual([]);
  });
});
