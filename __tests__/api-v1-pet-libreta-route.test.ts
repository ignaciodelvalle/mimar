// `GET /api/v1/pets/{publicToken}/libreta` — the ledger, over bearer auth.
//
// WHAT THIS FILE HAS TO PROVE
// ---------------------------------------------------------------------------
//   1. THE PROJECTION, and specifically what does NOT cross. The reader answers
//      with the share tokens, the weight series, the microchip number and a
//      signed attachment URL per rendered event. None of those belong in a
//      payload a phone stores, and a test that only checked the fields present
//      would certify exactly the half nobody gets wrong.
//   2. NO SIGNED URL IS EVEN MINTED. `signAttachments: false` is not a
//      formatting choice: minting is equivalent to handing out the file, and a
//      250-row ledger would hand out 250. Asserted at the call, not at the
//      output, because "we minted them and dropped them" produces the same
//      output and is a different thing.
//   3. THE AUDIENCE FILTER IS THE WEB'S, and it runs on the SERVER. An org/vet
//      viewer's device must never receive the rows the web's libreta face hides
//      from them in a client component.
//   4. A CORRECTION READS AS A CORRECTION. The values are the corrected ones and
//      `amendedAt` says so — the original is never presented as current, and the
//      `event_amended` row itself is still an entry.
//   5. `canAmend` is the conjunction the web computes, not a role check a client
//      re-derives — including the deceased clamp the web's button lacks.
//   6. The auth mapping matches its siblings, and `cache-control: no-store` is
//      on every branch.
//
// The reader itself is mocked: its bounded window, its amendment overlay and its
// audience-independent queries are proved without Postgres in
// `src/modules/pets/application/tab-data/__tests__/get-libreta-face-data.test.ts`.
// What is asserted here is what the ROUTE and the PROJECTION do with the answer.

import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  live: null as null | (() => unknown),
  limiterThrows: null as null | (() => never),
  limits: [] as Array<{ endpoint: string; identifier: string }>,
  access: null as null | (() => unknown),
  read: null as null | (() => unknown),
  /** Every options object the reader was called with. */
  readOptions: [] as unknown[],
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
      control.limiterThrows?.();
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

vi.mock("@/src/modules/pets/application/tab-data/get-libreta-face-data", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/src/modules/pets/application/tab-data/get-libreta-face-data")
    >();
  return {
    ...actual,
    getLibretaFaceData: async (_ctx: unknown, options: unknown) => {
      control.readOptions.push(options);
      return control.read ? control.read() : { ok: true, data: faceData() };
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

import { RateLimitError } from "@/lib/infra/rate-limit";
import { PET_LIBRETA_PAYLOAD_VERSION, type PetLibretaV1 } from "@dim/contract/api";

import { buildPetLibretaV1 } from "@/app/api/v1/pets/[publicToken]/libreta/payload";
import { GET } from "@/app/api/v1/pets/[publicToken]/libreta/route";
import type { LibretaFaceData } from "@/src/modules/pets/application/tab-data/types";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "DIM-PAMP-0001";
const NOW = new Date("2026-08-25T15:00:00Z");

/** The one attachment URL a leaky projection would carry through. */
const SIGNED_URL = "https://storage.example/signed?token=SECRET_SIGNATURE";
/** The one share token a leaky projection would carry through. */
const SHARE_TOKEN = "SECRET_SHARE_TOKEN";

function petRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    publicToken: TOKEN,
    name: "Pampa",
    status: "active",
    species: "dog",
    sex: "female",
    ...overrides,
  };
}

function pastRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    petId: petRow().id,
    eventType: "vaccination_administered",
    payload: { vaccine_name: "Antirrábica", batch: "L-42" },
    occurredAt: new Date("2026-08-20T12:00:00Z"),
    notes: null,
    recordedByUserId: OWNER_ID,
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    attachmentUrl: SIGNED_URL,
    hasAttachment: true,
    amendedAt: null,
    ...overrides,
  };
}

function faceData(overrides: Partial<LibretaFaceData> = {}): LibretaFaceData {
  return {
    identity: {
      name: "Pampa",
      species: "dog",
      breed: "Caniche",
      sex: "female",
      microchipId: "SECRET_CHIP_982000123456789",
      tattooCode: "SECRET_TATTOO",
      tattooLocation: "oreja",
      publicToken: TOKEN,
    },
    future: [
      {
        id: "rem-1",
        kind: "reminder",
        label: "Antirrábica anual",
        dueAt: new Date("2026-09-01T12:00:00Z"),
        reminderId: "rem-1",
        action: { type: "reschedule", href: "/mis-mascotas/DIM-PAMP-0001/vacunas" },
      },
    ],
    past: [pastRow()],
    pastTruncated: false,
    summary: {
      active: 1,
      dueSoon: 0,
      expired: 0,
      missing: 0,
      unconfirmed: 0,
      otherCount: 0,
      perVaccine: [
        {
          vaccineName: "Antirrábica",
          lastDoseAt: new Date("2026-08-20T12:00:00Z"),
          nextDueAt: new Date("2027-08-20T12:00:00Z"),
          status: "active",
        },
      ],
    },
    weightSamples: [{ date: new Date("2026-08-01T12:00:00Z"), kg: 12.4 }],
    activeShares: [{ token: SHARE_TOKEN }] as unknown as LibretaFaceData["activeShares"],
    accessPath: "owner",
    viewer: { userId: OWNER_ID, currentOwnerUserId: OWNER_ID },
    ...overrides,
  } as LibretaFaceData;
}

function build(input: {
  accessPath?: "owner" | "org";
  petStatus?: string;
  holderRole?: string | null;
  data?: LibretaFaceData;
}): PetLibretaV1 {
  return buildPetLibretaV1({
    publicToken: TOKEN,
    petStatus: input.petStatus ?? "active",
    accessPath: input.accessPath ?? "owner",
    holderRole: input.holderRole === undefined ? "owner" : input.holderRole,
    data: input.data ?? faceData(),
    now: NOW,
  });
}

function okSection<T>(section: { status: string; data?: T }): T {
  if (section.status !== "ok") throw new Error("expected an ok section");
  return section.data as T;
}

async function call(headers: Record<string, string> = { authorization: "Bearer tok" }) {
  return GET(new Request(`https://www.mimar.com.ar/api/v1/pets/${TOKEN}/libreta`, { headers }), {
    params: Promise.resolve({ publicToken: TOKEN }),
  });
}

beforeEach(() => {
  control.live = null;
  control.limiterThrows = null;
  control.limits = [];
  control.access = null;
  control.read = null;
  control.readOptions = [];
});

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

describe("buildPetLibretaV1 — what crosses, and what must not", () => {
  it("projects an asiento through the web's own template", () => {
    const entry = okSection(build({}).timeline).entries[0];
    expect(entry?.eventId).toBe("evt-1");
    expect(entry?.eventType).toBe("vaccination_administered");
    // The eyebrow the web prints for a rabies dose, composed server-side.
    expect(entry?.kind).toBe("Vacuna · obligatoria");
    expect(entry?.title).toBe("Antirrábica");
    expect(entry?.facts.find((f) => f.key === "Lote")?.value).toBe("L-42");
    // A field the record does not carry is a PLACEHOLDER, flagged as such —
    // not a value somebody wrote.
    const via = entry?.facts.find((f) => f.key === "Vía");
    expect(via?.value).toBe("Sin dato");
    expect(via?.missing).toBe(true);
  });

  it("carries no signed URL, no share token, no weight series and no chip number", () => {
    // Serialised, because the point is that NONE of these appear ANYWHERE in
    // the payload — including inside a field this test did not think to name.
    const wire = JSON.stringify(build({}));
    expect(wire).not.toContain(SIGNED_URL);
    expect(wire).not.toContain(SHARE_TOKEN);
    expect(wire).not.toContain("SECRET_CHIP_982000123456789");
    expect(wire).not.toContain("SECRET_TATTOO");
    expect(wire).not.toContain("12.4");
    // The web href a future-ledger row carries is a web address, not a fact.
    expect(wire).not.toContain("/mis-mascotas/");
  });

  it("reports the PRESENCE of an attachment even though the URL is gone", () => {
    // The two are different questions, and answering the first with a null URL
    // would collapse "no file" into "we did not sign one".
    expect(okSection(build({}).timeline).entries[0]?.hasAttachment).toBe(true);
  });

  it("keeps the future ledger's actionable id and drops its web action", () => {
    const item = okSection(build({}).upcoming).items[0];
    expect(item?.reminderId).toBe("rem-1");
    expect(item).not.toHaveProperty("action");
  });

  it("declares the version and the freshness at the TOP level", () => {
    const payload = build({});
    expect(payload.payloadVersion).toBe(PET_LIBRETA_PAYLOAD_VERSION);
    expect(payload.issuedAt).toBe(NOW.toISOString());
    expect(new Date(payload.staleAfter).getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe("buildPetLibretaV1 — a correction reads as a correction", () => {
  it("carries the corrected value AND the marker that says it was corrected", () => {
    // The reader has already overlaid the amendment, so the payload here is the
    // CORRECTED one. What this pins is that the marker survives the projection:
    // without it a client renders a corrected record as if nobody had ever
    // questioned it.
    const amendedAt = new Date("2026-08-22T10:00:00Z");
    const data = faceData({
      past: [
        pastRow({ payload: { vaccine_name: "Antirrábica (corregida)" }, amendedAt }),
        pastRow({
          id: "evt-2",
          eventType: "event_amended",
          payload: { target_event_id: "evt-1", changes: [], reason: "Nombre mal cargado" },
          occurredAt: amendedAt,
          amendedAt: null,
        }),
      ],
    });
    const entries = okSection(build({ data }).timeline).entries;
    expect(entries[0]?.title).toBe("Antirrábica (corregida)");
    expect(entries[0]?.amendedAt).toBe(amendedAt.toISOString());
    // THE CORRECTION IS ITSELF AN ENTRY. An append-only ledger that hid the
    // correcting event would be showing a value with no trace of where it came
    // from.
    expect(entries[1]?.eventId).toBe("evt-2");
    expect(entries[1]?.eventType).toBe("event_amended");
    expect(entries[1]?.amendedAt).toBeNull();
  });
});

describe("buildPetLibretaV1 — the audience filter runs on this side", () => {
  it("hides the non-libreta-sanitaria rows from an org viewer", () => {
    const data = faceData({
      past: [
        pastRow(),
        pastRow({ id: "evt-note", eventType: "note_added", payload: { text: "x" } }),
      ],
    });
    const owner = okSection(build({ data }).timeline).entries.map((e) => e.eventType);
    expect(owner).toEqual(["vaccination_administered", "note_added"]);

    const org = okSection(build({ data, accessPath: "org", holderRole: null }).timeline);
    expect(org.entries.map((e) => e.eventType)).toEqual(["vaccination_administered"]);
    // `total` counts what this READ returned; `truncated` still answers "are
    // there older asientos than these", which the filter never changes.
    expect(org.total).toBe(1);
  });

  it("keeps the reader's truncation flag, which is about the WINDOW", () => {
    const section = okSection(build({ data: faceData({ pastTruncated: true }) }).timeline);
    expect(section.truncated).toBe(true);
  });
});

describe("buildPetLibretaV1 — who may correct a record", () => {
  it("offers the correction on an amendable type for a person-path holder", () => {
    const payload = build({});
    expect(payload.viewer.canAmend).toBe(true);
    expect(okSection(payload.timeline).entries[0]?.canAmend).toBe(true);
  });

  it("refuses it on a type the allowlist excludes, viewer notwithstanding", () => {
    // `death_recorded` is forensic and has no reversal path.
    const data = faceData({ past: [pastRow({ eventType: "death_recorded", payload: {} })] });
    const payload = build({ data });
    expect(payload.viewer.canAmend).toBe(true);
    expect(okSection(payload.timeline).entries[0]?.canAmend).toBe(false);
  });

  it("refuses it on a record a professional signed, or another person wrote (PO decision 3B)", () => {
    const data = faceData({
      past: [
        pastRow({ id: "evt-vet", authorRole: "vet", authorVerified: true }),
        pastRow({ id: "evt-other", recordedByUserId: "99999999-9999-4999-8999-999999999999" }),
      ],
    });
    const payload = build({ data });
    // The viewer may still correct records in general — just not these.
    expect(payload.viewer.canAmend).toBe(true);
    expect(okSection(payload.timeline).entries.map((e) => e.canAmend)).toEqual([false, false]);
  });

  it("refuses it on the ORG path, mirroring the web's own affordance", () => {
    const payload = build({ accessPath: "org", holderRole: null });
    expect(payload.viewer.canAmend).toBe(false);
    expect(payload.viewer.role).toBe("org_member");
    expect(payload.viewer.isTitular).toBe(false);
  });

  it("refuses it for a DECEASED animal, which the web's button does not", () => {
    // The server refuses every new event on a deceased pet, so a button that is
    // always refused is a control that cannot do anything.
    const payload = build({ petStatus: "deceased" });
    expect(payload.viewer.canAmend).toBe(false);
    expect(okSection(payload.timeline).entries[0]?.canAmend).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

describe("GET /api/v1/pets/{token}/libreta — the door", () => {
  it("answers 200 with no-store and never asks the reader to sign a URL", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    // ASSERTED AT THE CALL. Minting and discarding produces the same body and
    // is a different thing: a signed URL is the file.
    expect(control.readOptions).toEqual([{ signAttachments: false }]);
  });

  it("spends its own buckets — the IP one before auth, the user one after", async () => {
    await call();
    expect(control.limits).toEqual([
      { endpoint: "api_v1_pet_libreta_ip", identifier: expect.any(String) },
      { endpoint: "api_v1_pet_libreta_user", identifier: OWNER_ID },
    ]);
  });

  it("answers 401 without a bearer, and never writes a counter for it", async () => {
    const response = await call({});
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "auth_required" });
    expect(control.limits).toEqual([]);
  });

  it("answers 404 for a pet this caller may not read", async () => {
    control.access = () => ({ kind: "none" });
    const response = await call();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 429 over the limit, with no body detail about the pet", async () => {
    control.limiterThrows = () => {
      throw new RateLimitError(new Date("2026-08-25T15:01:00Z"), "minute");
    };
    const response = await call();
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
  });

  it("FAILS OPEN when the limiter itself is broken", async () => {
    // The limiter is a DB write. Refusing here would blank every owner's ledger
    // over an abuse control; the access guard is the one that fails closed.
    control.limiterThrows = () => {
      throw new Error("rate_limit_buckets unavailable");
    };
    const response = await call();
    expect(response.status).toBe(200);
  });

  it("answers 503 with a retry-after when the read refuses, NOT an empty ledger", async () => {
    control.read = () => ({ ok: false, error: "Acceso denegado" });
    const response = await call();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("maps an expired operator shift to its own code, not to auth_expired", async () => {
    control.live = () => ({ ok: false, reason: "SHIFT_EXPIRED" });
    const response = await call();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "session_shift_expired" });
  });
});
