// `GET /api/v1/pets/{publicToken}/events/{eventId}` — one asiento, in full.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. THE CURATED PROJECTION HOLDS. This is the first `/api/v1` endpoint that
//      returns a whole event payload, and the record it reads carries hashes and
//      internal ids alongside the human fields. The fixture puts them there ON
//      PURPOSE and the test looks for them in the serialised payload — a test
//      that only checked the fields present would certify the easy half.
//   2. THE AUTHOR IS A ROLE, NEVER A PERSON. The one identity that may be named
//      is an organization's.
//   3. THE CORRECTION HISTORY IS DERIVED, NOT ECHOED. The spine's `changes`
//      array is over RAW payload keys and may name un-curated ones; what reaches
//      a client is a diff of the whitelisted rows. And each step is diffed
//      against the state BEFORE IT — a chain of two must not report the second
//      correction as having also made the first.
//   4. THE EXPIRY IS THE REAL ONE. `expiresAt` must be derived from the same
//      number handed to the signer, because two constants that agree today are
//      two constants.
//   5. A LINK THAT COULD NOT BE MINTED IS NOT AN ABSENT FILE, and a Storage
//      outage is not an empty attachment list.
//   6. 404 for an event of ANOTHER animal, for a malformed id, and for a pet the
//      caller may not read — all answering identically.

import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  live: null as null | (() => unknown),
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  access: null as null | (() => unknown),
  read: null as null | (() => unknown),
  /** Every (path, ttl) pair the signer was asked for. */
  signed: [] as Array<{ path: string; ttl: number }>,
  signResult: null as null | ((path: string) => string | null),
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

vi.mock("@/lib/infra/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/storage")>();
  return {
    ...actual,
    eventAttachmentSignedUrl: async (path: string, ttl: number) => {
      control.signed.push({ path, ttl });
      return control.signResult
        ? control.signResult(path)
        : `https://storage.example/${path}?sig=X`;
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

import {
  EVENT_ATTACHMENT_LINK_TTL_SECONDS,
  PET_EVENT_DETAIL_PAYLOAD_VERSION,
  type PetEventDetailV1,
} from "@dim/contract/api";

import { buildPetEventDetailV1 } from "@/app/api/v1/pets/[publicToken]/events/[eventId]/payload";
import { GET } from "@/app/api/v1/pets/[publicToken]/events/[eventId]/route";
import type { TitularTenure } from "@/lib/infra/amendment";
import type { PetEventDetailRead } from "@/src/modules/events/application/read/load-pet-event-detail";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PET_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const AMEND_ID = "44444444-4444-4444-8444-444444444444";
const TOKEN = "DIM-PAMP-0001";
const NOW = new Date("2026-08-25T15:00:00Z");

const SECRET_HASH = "SECRET_FIRMA_HASH_9f2c";
const SECRET_CHIP = "SECRET_MATCHED_CHIP_777";

function petRow(overrides: Record<string, unknown> = {}) {
  return { id: PET_ID, publicToken: TOKEN, name: "Pampa", status: "active", ...overrides };
}

function detailRead(overrides: Partial<PetEventDetailRead> = {}): PetEventDetailRead {
  const originalPayload: Record<string, unknown> = {
    vaccine_name: "Antirrábica",
    brand: "Nobivac",
    batch: "L-42",
    // Fields the curated whitelist must never emit.
    firma_hash: SECRET_HASH,
    matched_chip_number: SECRET_CHIP,
    source: "internal",
  };
  return {
    id: EVENT_ID,
    eventType: "vaccination_administered",
    payload: originalPayload,
    originalPayload,
    occurredAt: new Date("2026-08-20T12:00:00Z"),
    recordedAt: new Date("2026-08-21T09:00:00Z"),
    notes: "Se portó bien.",
    authorRole: "vet",
    authorVerified: true,
    authorOrganizationId: "org-1",
    authorOrgName: "Veterinaria Palermo",
    // The individual who wrote it. It must not reach the wire.
    recordedByUserId: OWNER_ID,
    locationLat: null,
    locationLng: null,
    amendments: [],
    attachments: [],
    ...overrides,
  };
}

function build(input: {
  read?: PetEventDetailRead;
  accessPath?: "owner" | "org";
  petStatus?: string;
  viewer?: { userId: string; titularTenures: TitularTenure[] };
  attachments?: PetEventDetailV1["attachments"] extends { data: infer _D } ? never : never;
}): PetEventDetailV1 {
  return buildPetEventDetailV1({
    publicToken: TOKEN,
    petStatus: input.petStatus ?? "active",
    accessPath: input.accessPath ?? "owner",
    viewer: input.viewer ?? { userId: OWNER_ID, titularTenures: [] },
    read: input.read ?? detailRead(),
    attachments: [],
    now: NOW,
  });
}

async function call(eventId: string = EVENT_ID) {
  return GET(
    new Request(`https://www.mimar.com.ar/api/v1/pets/${TOKEN}/events/${eventId}`, {
      headers: { authorization: "Bearer tok" },
    }),
    {
      params: Promise.resolve({ publicToken: TOKEN, eventId }),
    },
  );
}

beforeEach(() => {
  control.live = null;
  control.limits = [];
  control.access = null;
  control.read = null;
  control.signed = [];
  control.signResult = null;
});

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

describe("buildPetEventDetailV1 — the curated projection", () => {
  it("emits the whitelisted fields and NOTHING the payload also carries", () => {
    const payload = build({});
    expect(payload.kind).toBe("Vacuna administrada");
    // The web's own heading for this type, verbatim — `eventPayloadSummary`.
    expect(payload.title).toBe("Vacuna: Antirrábica");
    expect(payload.facts.map((f) => f.label)).toEqual(["Vacuna", "Marca", "Lote"]);
    // The payload KEY rides along so a correction form can name the field the
    // server will change — and only ever a field the whitelist already renders.
    expect(payload.facts.map((f) => f.field)).toEqual(["vaccine_name", "brand", "batch"]);

    const wire = JSON.stringify(payload);
    expect(wire).not.toContain(SECRET_HASH);
    expect(wire).not.toContain(SECRET_CHIP);
    // The individual author's id — WHO wrote it reaches a citizen as a ROLE.
    expect(wire).not.toContain(OWNER_ID);
    expect(wire).not.toContain(PET_ID);
  });

  it("names the author's ROLE and the signing ORGANIZATION, never a person", () => {
    const payload = build({});
    expect(payload.author).toEqual({
      roleLabel: "Veterinario/a",
      verified: true,
      orgDisplayName: "Veterinaria Palermo",
    });
  });

  it("separates when it HAPPENED from when it was WRITTEN", () => {
    const payload = build({});
    expect(payload.occurredAt).toBe("2026-08-20T12:00:00.000Z");
    expect(payload.recordedAt).toBe("2026-08-21T09:00:00.000Z");
    expect(payload.payloadVersion).toBe(PET_EVENT_DETAIL_PAYLOAD_VERSION);
  });
});

describe("buildPetEventDetailV1 — the correction history", () => {
  const original: Record<string, unknown> = {
    vaccine_name: "Antirábica",
    brand: "Nobivac",
    firma_hash: SECRET_HASH,
  };

  it("speaks in curated LABELS, never in the spine's raw field keys", () => {
    const read = detailRead({
      originalPayload: original,
      payload: { ...original, vaccine_name: "Antirrábica" },
      amendments: [
        {
          amendmentId: AMEND_ID,
          occurredAt: new Date("2026-08-22T10:00:00Z"),
          reason: "Estaba mal escrito",
          actorRole: "owner",
          authorRole: "owner",
          recordedByUserId: OWNER_ID,
          authorVerified: false,
          recordedAt: new Date("2026-08-22T10:00:00Z"),
          changes: [{ field: "vaccine_name", old: "Antirábica", new: "Antirrábica" }],
        },
      ],
    });
    const section = build({ read }).amendments;
    if (section.status !== "ok") throw new Error("amendments must be ok");
    const [step] = section.data.items;
    expect(step?.actorRoleLabel).toBe("Dueño/a");
    expect(step?.reason).toBe("Estaba mal escrito");
    expect(step?.changes).toEqual([{ label: "Vacuna", from: "Antirábica", to: "Antirrábica" }]);
    // The raw key never appears — only its es-AR label.
    expect(JSON.stringify(section)).not.toContain("vaccine_name");
  });

  it("diffs each step against the state BEFORE IT, not against the original", () => {
    // Two corrections. The second changed only the brand; reporting it as also
    // having changed the name would make the history disagree with itself.
    const read = detailRead({
      originalPayload: original,
      payload: { ...original, vaccine_name: "Antirrábica", brand: "Rabisin" },
      amendments: [
        {
          amendmentId: AMEND_ID,
          occurredAt: new Date("2026-08-22T10:00:00Z"),
          reason: null,
          actorRole: "owner",
          authorRole: "owner",
          recordedByUserId: OWNER_ID,
          authorVerified: false,
          recordedAt: new Date("2026-08-22T10:00:00Z"),
          changes: [{ field: "vaccine_name", old: "Antirábica", new: "Antirrábica" }],
        },
        {
          amendmentId: "55555555-5555-4555-8555-555555555555",
          occurredAt: new Date("2026-08-23T10:00:00Z"),
          reason: null,
          actorRole: "vet",
          authorRole: "vet",
          recordedByUserId: null,
          authorVerified: false,
          recordedAt: new Date("2026-08-22T10:00:00Z"),
          changes: [{ field: "brand", old: "Nobivac", new: "Rabisin" }],
        },
      ],
    });
    const section = build({ read }).amendments;
    if (section.status !== "ok") throw new Error("amendments must be ok");
    expect(section.data.items[0]?.changes).toEqual([
      { label: "Vacuna", from: "Antirábica", to: "Antirrábica" },
    ]);
    expect(section.data.items[1]?.changes).toEqual([
      { label: "Marca", from: "Nobivac", to: "Rabisin" },
    ]);
    expect(section.data.items[1]?.actorRoleLabel).toBe("Veterinario/a");
  });

  it("keeps a correction that moved nothing CURATED, with an empty change list", () => {
    // A correction to an un-whitelisted key produces no visible diff. The
    // correction still happened, and hiding it would be worse than being unable
    // to say what it touched.
    const read = detailRead({
      originalPayload: original,
      payload: { ...original, source: "manual" },
      amendments: [
        {
          amendmentId: AMEND_ID,
          occurredAt: new Date("2026-08-22T10:00:00Z"),
          reason: "Ajuste interno",
          actorRole: "admin",
          authorRole: "owner",
          recordedByUserId: null,
          authorVerified: false,
          recordedAt: new Date("2026-08-22T10:00:00Z"),
          changes: [{ field: "source", old: "internal", new: "manual" }],
        },
      ],
    });
    const section = build({ read }).amendments;
    if (section.status !== "ok") throw new Error("amendments must be ok");
    expect(section.data.items).toHaveLength(1);
    expect(section.data.items[0]?.changes).toEqual([]);
  });
});

describe("buildPetEventDetailV1 — who may correct this record", () => {
  // PO decision 3B: the default fixture is VET-signed, so the person-path
  // holder's own record is spelled out here.
  const ownRecord = () =>
    detailRead({ authorRole: "owner", authorVerified: false, recordedByUserId: OWNER_ID });

  it("offers it on an amendable type for a person-path holder who wrote it", () => {
    expect(build({ read: ownRecord() }).amend).toEqual({ canAmend: true, refusal: null });
  });

  it("refuses a record a professional wrote, and says who can correct it", () => {
    // The default fixture: author_role vet, verified.
    expect(build({}).amend).toEqual({
      canAmend: false,
      refusal:
        "Este registro lo cargó o lo corrigió un profesional. Solo un profesional puede corregirlo.",
    });
  });

  it("refuses the holder's own record once a professional has corrected it", () => {
    const read = ownRecord();
    read.amendments = [
      {
        amendmentId: AMEND_ID,
        occurredAt: new Date("2026-08-22T10:00:00Z"),
        reason: null,
        actorRole: "owner",
        authorRole: "vet",
        authorVerified: true,
        recordedByUserId: "99999999-9999-4999-8999-999999999999",
        recordedAt: new Date("2026-08-22T10:00:00Z"),
        changes: [{ field: "brand", old: "Nobivac", new: "Rabisin" }],
      },
    ];
    expect(build({ read }).amend.canAmend).toBe(false);
  });

  it("refuses a record ANOTHER person wrote — a previous titular's, say", () => {
    const read = detailRead({
      authorRole: "owner",
      authorVerified: false,
      recordedByUserId: "99999999-9999-4999-8999-999999999999",
    });
    expect(build({ read }).amend).toEqual({
      canAmend: false,
      refusal: "Solo quien cargó este registro puede corregirlo.",
    });
  });

  it("gives a legacy owner row with no author only to a viewer whose tenure covers it", () => {
    // recordedAt of the default fixture: 2026-08-21.
    const read = detailRead({ authorRole: "owner", authorVerified: false, recordedByUserId: null });
    const tenure = (startedAt: string, endedAt: string | null) => ({
      userId: OWNER_ID,
      titularTenures: [
        { startedAt: new Date(startedAt), endedAt: endedAt ? new Date(endedAt) : null },
      ],
    });
    expect(build({ read, viewer: tenure("2026-01-01T00:00:00Z", null) }).amend.canAmend).toBe(true);
    // Became titular AFTER the row was written: the previous owner's row.
    expect(build({ read, viewer: tenure("2026-09-01T00:00:00Z", null) }).amend).toEqual({
      canAmend: false,
      refusal: "Solo quien cargó este registro puede corregirlo.",
    });
    // No titular-side tenure at all (a caretaker, say).
    expect(build({ read }).amend.canAmend).toBe(false);
  });

  it("refuses a type outside the allowlist, without naming the internal slug", () => {
    const read = detailRead({ eventType: "death_recorded", payload: {}, originalPayload: {} });
    const amend = build({ read }).amend;
    expect(amend.canAmend).toBe(false);
    expect(amend.refusal).toBe("Este tipo de registro no admite correcciones.");
    expect(amend.refusal).not.toContain("death_recorded");
  });

  it("refuses on the ORG path, mirroring the web's own affordance", () => {
    expect(build({ accessPath: "org" }).amend).toEqual({
      canAmend: false,
      refusal: "Solo quien tiene la mascota a su cargo puede corregir un registro.",
    });
  });

  it("refuses on a deceased animal FIRST — it refuses every type", () => {
    // Order matters: reporting "this type is not amendable" here would send
    // somebody looking for a different record to correct.
    const read = detailRead({ eventType: "death_recorded", payload: {}, originalPayload: {} });
    expect(build({ read, petStatus: "deceased" }).amend.refusal).toBe(
      "Esta mascota está registrada como fallecida y no acepta nuevos eventos.",
    );
  });
});

describe("buildPetEventDetailV1 — a Storage outage is not an empty list", () => {
  it("reports the attachments section as unavailable when signing could not run", () => {
    const payload = buildPetEventDetailV1({
      publicToken: TOKEN,
      petStatus: "active",
      accessPath: "owner",
      viewer: { userId: OWNER_ID, titularTenures: [] },
      read: detailRead(),
      attachments: null,
      now: NOW,
    });
    expect(payload.attachments).toEqual({ status: "unavailable" });
    // The record itself still reads.
    // The web's own heading for this type, verbatim — `eventPayloadSummary`.
    expect(payload.title).toBe("Vacuna: Antirrábica");
  });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

describe("GET /api/v1/pets/{token}/events/{eventId} — the door", () => {
  it("signs each file for the CONTRACT's TTL and stamps the matching expiry", async () => {
    control.read = () =>
      detailRead({
        attachments: [
          { id: "att-1", mimeType: "image/jpeg", storagePath: "pet/1/carnet.jpg" },
          { id: "att-2", mimeType: "application/pdf", storagePath: "pet/1/receta.pdf" },
        ],
      });
    const response = await call();
    expect(response.status).toBe(200);
    const body = (await response.json()) as PetEventDetailV1;

    // THE SAME NUMBER reached the signer.
    expect(control.signed.map((s) => s.ttl)).toEqual([
      EVENT_ATTACHMENT_LINK_TTL_SECONDS,
      EVENT_ATTACHMENT_LINK_TTL_SECONDS,
    ]);

    if (body.attachments.status !== "ok") throw new Error("attachments must be ok");
    const [image, file] = body.attachments.data.items;
    expect(image?.kind).toBe("image");
    // Not an image: this client has no PDF viewer, so it opens in the browser.
    expect(file?.kind).toBe("file");

    // …and the stamped expiry is that number after the payload was issued.
    const issued = Date.parse(body.issuedAt);
    const expires = Date.parse(image?.expiresAt ?? "");
    expect(Math.round((expires - issued) / 1000)).toBe(EVENT_ATTACHMENT_LINK_TTL_SECONDS);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("distinguishes a file that could not be signed from a record with no files", async () => {
    control.signResult = () => null;
    control.read = () =>
      detailRead({
        attachments: [{ id: "att-1", mimeType: "image/jpeg", storagePath: "pet/1/gone.jpg" }],
      });
    const body = (await (await call()).json()) as PetEventDetailV1;
    if (body.attachments.status !== "ok") throw new Error("attachments must be ok");
    const [item] = body.attachments.data.items;
    // The row is still there — the owner knows a file was attached — and both
    // the link and its countdown are absent, because a countdown on nothing is
    // worse than none.
    expect(item?.url).toBeNull();
    expect(item?.expiresAt).toBeNull();
  });

  it("never signs anything for a record with no files", async () => {
    await call();
    expect(control.signed).toEqual([]);
  });

  it("spends its own buckets — the IP one before auth, the user one after", async () => {
    await call();
    expect(control.limits).toEqual([
      { endpoint: "api_v1_pet_event_detail_ip", identifier: expect.any(String) },
      { endpoint: "api_v1_pet_event_detail_user", identifier: OWNER_ID },
    ]);
  });

  it("answers 404 for a malformed event id, before any query runs", async () => {
    const response = await call("not-a-uuid");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 404 for an event that belongs to another animal", async () => {
    // The reader is pet-fenced, so a real id under the wrong pet resolves to
    // nothing — identically to an id that never existed.
    control.read = () => null;
    const response = await call();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("answers 404 for a pet this caller may not read", async () => {
    control.access = () => ({ kind: "none" });
    const response = await call();
    expect(response.status).toBe(404);
    // Nothing was read, so nothing was signed.
    expect(control.signed).toEqual([]);
  });

  it("maps an expired operator shift to its own code, not to auth_expired", async () => {
    control.live = () => ({ ok: false, reason: "SHIFT_EXPIRED" });
    const response = await call();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "session_shift_expired" });
  });
});
