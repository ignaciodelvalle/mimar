// Unit test: setPetLostAction — coord-range hardening (P2 STEP 3).
//
// Before P2, setPetLostAction validated that coords are finite (isFinite) but
// did NOT check whether they fall in the WGS-84 range (-90..90 / -180..180).
// P2 closes this gap: out-of-range coords are now rejected with an error.
//
// Tests:
//   1. Valid coords (in range) → no coord error (continues to auth check).
//   2. Out-of-range lat (> 90) → "fuera de rango" error (no DB access).
//   3. Out-of-range lng (< -180) → "fuera de rango" error (no DB access).
//   4. Non-finite coords (NaN from "abc") → original "inválidas" error preserved.
//   5. Absent coords (no lat/lng in formData) → no coord error (coords are optional
//      for MarkLost — only the range of PRESENT coords is checked).
//
// Auth is short-circuited by mocking requirePetAccess so we never hit the DB.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: server-only
// ---------------------------------------------------------------------------
vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// Mock: requirePetAccess — make it return "no access" so the action exits
// early without touching any DB. We only care about the coord-validation
// path which runs AFTER auth, so we need the action to reach the validation
// block. We mock access as successful but with a stub pet + user.
// ---------------------------------------------------------------------------

const mockRequirePetAccess = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/pet-access", () => ({
  requirePetAccess: mockRequirePetAccess,
  requireAlivePetAccess: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: all DB / repo / broadcast dependencies — none should be called for
// out-of-range coord paths.
// ---------------------------------------------------------------------------

const mockInsertEvent = vi.hoisted(() => vi.fn());
const mockUpdatePetLostProjection = vi.hoisted(() => vi.fn());
const mockInsertIdentification = vi.hoisted(() => vi.fn());
const mockTransaction = vi.hoisted(() =>
  vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
);
const mockBroadcastLostPet = vi.hoisted(() => vi.fn());

vi.mock("@/lib/infra/lost-pet-broadcast", () => ({
  broadcastLostPet: mockBroadcastLostPet,
}));

vi.mock("@/lib/domain/location", () => ({
  writePoint: vi.fn((p: { lat: number; lng: number } | null) =>
    p
      ? { locationLat: String(p.lat), locationLng: String(p.lng) }
      : { locationLat: null, locationLng: null },
  ),
}));

vi.mock("@/lib/infra/case-helpers", () => ({
  openCase: vi.fn().mockResolvedValue({ id: "case-stub" }),
  closeCase: vi.fn(),
  findOpenCaseForPetAndKind: vi.fn(),
}));

vi.mock("@/lib/events/event-schemas", () => ({
  validateEventPayload: vi.fn((_type: string, payload: unknown) => payload),
}));

vi.mock("@/lib/domain/microchip-validation", () => ({
  validateMicrochipId: vi.fn(),
}));

vi.mock("@/lib/infra/tattoo-lookup", () => ({
  normalizeTattooCode: vi.fn(),
}));

vi.mock("@/lib/infra/pet-identifiers", () => ({
  fetchActiveIdentifications: vi.fn().mockResolvedValue({ microchip: null, tattoo: null }),
}));

vi.mock("@/lib/ui/form-checkbox", () => ({
  checkboxOn: vi.fn(() => false),
}));

// EventsRepository — wire the mock methods.
vi.mock("@/src/modules/events/infrastructure/events-repository", () => ({
  EventsRepository: class {
    insertEvent = mockInsertEvent;
    updatePetLostProjection = mockUpdatePetLostProjection;
    insertIdentification = mockInsertIdentification;
  },
}));

// @/db — the REAL schema (tables, enums) under a MOCKED client.
//
// The schema is spread from db/schema.ts, which never constructs a pool, so a
// module-eval read of any column or enum keeps working as the action's import
// graph grows (excludeResolvedLostEpisodeSql reads `notifications.*`;
// rehome-death-cascade reads `authorRoleEnum.enumValues`). A hand-listed subset
// is what broke this file for four consecutive full runs on 2026-08-22, three
// of them on CI: vitest's mock proxy throws on the first export the list forgot,
// the file dies at collection with zero tests, and the suite verdict counted
// that as "0 failing test(s)" — misread as the worker-teardown crash for days.
//
// Precedent for the FULL spread: lib/metrics/alert-evaluation.test.ts
// (`...actual` from "@/db" under a mocked client). The commit that fixed this
// file (2f962281) cited push-subscription-action.test.ts instead; that one
// cherry-picks ONE export (`pushSubscriptions`) and is the narrow shape, not
// this one.
//
// db.transaction calls the callback immediately (synchronous mock).
vi.mock("@/db", async () => {
  const schema = await vi.importActual<typeof import("@/db/schema")>("@/db/schema");
  return {
    ...schema,
    db: {
      transaction: mockTransaction,
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => []) })) })),
      })),
    },
  };
});

// next/navigation — avoid redirect errors.
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

// next/cache — setPetLostAction revalidates the owner page, the public
// credential and the pet list on success (T1-C1, 2026-09-18), and the real
// revalidatePath throws outside a Next request.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after all mocks)
// ---------------------------------------------------------------------------

import { setPetLostAction } from "@/src/modules/events/actions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  // Minimal valid form fields for the MarkLost flow.
  fd.set("locationAddress", "Plaza de Mayo, CABA");
  fd.set("discloseFirstNameWhenLost", "on");
  fd.set("allowFinderFormWhenLost", "on");
  // Prevent redirect so the action returns a value instead of throwing.
  fd.set("noRedirect", "1");
  for (const [k, v] of Object.entries(overrides)) {
    fd.set(k, v);
  }
  return fd;
}

const PET_ID = "pet-0000-0000-0000-000000000001";
const USER_ID = "user-0000-0000-0000-000000000001";

const stubAccess = {
  ok: true as const,
  user: { id: USER_ID },
  pet: {
    id: PET_ID,
    publicToken: "abc123",
    name: "Rex",
    status: "active",
    species: "dog",
    breed: "Labrador",
    color: "yellow",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    discloseFirstNameWhenLost: true,
    disclosePhoneWhenLost: false,
    discloseEmailWhenLost: true,
    discloseLastLocationWhenLost: false,
    allowFinderFormWhenLost: true,
  },
  eventAuthorship: {
    authorRole: "owner",
    authorOrganizationId: null,
    authorVerified: false,
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setPetLostAction — coord-range hardening (P2 STEP 3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequirePetAccess.mockResolvedValue(stubAccess);
    mockInsertEvent.mockResolvedValue({ id: "evt-stub" });
    mockUpdatePetLostProjection.mockResolvedValue(undefined);
    mockBroadcastLostPet.mockResolvedValue(undefined);
  });

  it("accepts valid in-range coords and does not return a coord error", async () => {
    const fd = makeFormData({ locationLat: "-34.6037", locationLng: "-58.3816" });
    const result = await setPetLostAction("abc123", { error: null }, fd);
    // Should not be a coord error — either success (null) or some other error.
    expect(typeof result.error === "string" && /fuera de rango/i.test(result.error)).toBe(false);
    expect(typeof result.error === "string" && /inválidas/i.test(result.error)).toBe(false);
  });

  it("rejects out-of-range latitude (> 90)", async () => {
    const fd = makeFormData({ locationLat: "91", locationLng: "-58.3816" });
    const result = await setPetLostAction("abc123", { error: null }, fd);
    expect(result.error).toMatch(/fuera de rango/i);
    // No DB writes should have happened.
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects out-of-range longitude (< -180)", async () => {
    const fd = makeFormData({ locationLat: "-34.6037", locationLng: "-181" });
    const result = await setPetLostAction("abc123", { error: null }, fd);
    expect(result.error).toMatch(/fuera de rango/i);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("rejects out-of-range positive longitude (> 180)", async () => {
    const fd = makeFormData({ locationLat: "-34.6037", locationLng: "181" });
    const result = await setPetLostAction("abc123", { error: null }, fd);
    expect(result.error).toMatch(/fuera de rango/i);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("preserves original non-finite coord error message for NaN coords", async () => {
    const fd = makeFormData({ locationLat: "abc", locationLng: "xyz" });
    const result = await setPetLostAction("abc123", { error: null }, fd);
    // Pre-P2 behavior: non-finite → "Coordenadas inválidas". Still preserved.
    expect(result.error).toMatch(/inválidas/i);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("allows absent coords (coords are optional for MarkLost)", async () => {
    const fd = makeFormData(); // no locationLat / locationLng
    const result = await setPetLostAction("abc123", { error: null }, fd);
    // Absent coords should NOT produce a coord error.
    expect(typeof result.error === "string" && /fuera de rango/i.test(result.error)).toBe(false);
    expect(typeof result.error === "string" && /inválidas/i.test(result.error)).toBe(false);
  });
});
