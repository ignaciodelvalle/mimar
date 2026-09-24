// Unit tests for enableTier2PublicAction and revokeTier2PublicAction.
//
// Covers:
//   1. Access gate: requirePetAccess fails → action throws.
//   2. Deceased pet → enableTier2PublicAction throws (revoke is allowed on deceased).
//   3. Duration mapping:
//        "24h"    → tier2PublicEnabledUntil ≈ now + 24h, tier2PublicPermanent = false.
//        "7d"     → tier2PublicEnabledUntil ≈ now + 7d, tier2PublicPermanent = false.
//        "30d"    → tier2PublicEnabledUntil ≈ now + 30d, tier2PublicPermanent = false.
//        "siempre"→ tier2PublicPermanent = true, tier2PublicEnabledUntil = null.
//   4. Default duration (no FormData / unknown key) → falls back to 24h.
//   5. Revoke clears both tier2PublicPermanent and tier2PublicEnabledUntil.
//
// Mocking strategy:
//   - Mock @/lib/pet-access (requireTitularAccess) per test. Since
//     custodia-temporal the Tier-2 public toggle is a titular-only write — a
//     caretaker holds a Path-1 ownership row and must not open the credential.
//   - Mock @/db (db.update chain) and capture the .set() call.
//   - Mock next/cache (revalidatePath) as a no-op.

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PUBLIC_TOKEN = "DIM-T2P-TEST-001";
const PET_ID = "pet-t2p0-0000-0000-000000000001";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Mock: next/cache
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/pet-access
// ---------------------------------------------------------------------------

const mockRequireTitularAccess = vi.fn();
vi.mock("@/lib/infra/pet-access", () => ({
  requireTitularAccess: (token: string) => mockRequireTitularAccess(token),
}));

// ---------------------------------------------------------------------------
// Mock: @/db
//
// enableTier2PublicAction calls:
//   db.update(pets).set({...}).where(eq(pets.id, pet.id))
//
// We capture the value passed to .set() so each test can assert on it.
// ---------------------------------------------------------------------------

let capturedSetPayload: Record<string, unknown> | null = null;

const updateChain = {
  set: vi.fn((data: Record<string, unknown>) => {
    capturedSetPayload = data;
    return updateChain;
  }),
  where: vi.fn(async () => undefined),
};

const mockDb = {
  update: vi.fn(() => updateChain),
};

vi.mock("@/db", () => ({
  db: mockDb,
  pets: {},
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal();
  return actual as object;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePetAccessSuccess(petStatus = "active"): Record<string, unknown> {
  return {
    ok: true,
    supabase: {},
    user: { id: "user-t2p-001" },
    pet: { id: PET_ID, name: "Coco", status: petStatus, publicToken: PUBLIC_TOKEN },
    accessPath: "owner",
    error: null,
  };
}

function makeFormData(duration?: string): FormData {
  const fd = new FormData();
  if (duration !== undefined) fd.append("duration", duration);
  return fd;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enableTier2PublicAction", () => {
  beforeEach(() => {
    capturedSetPayload = null;
    updateChain.set.mockClear();
    updateChain.where.mockClear();
    mockDb.update.mockClear();
  });

  // ── Access gate ────────────────────────────────────────────────────────────

  it("throws when requirePetAccess returns ok:false", async () => {
    vi.resetModules();
    mockRequireTitularAccess.mockResolvedValue({ ok: false, error: "Sin permisos." });

    const { enableTier2PublicAction } = await import("@/app/actions/tier2-public");
    await expect(enableTier2PublicAction(PUBLIC_TOKEN)).rejects.toThrow("Sin permisos.");
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  // ── Deceased pet ───────────────────────────────────────────────────────────

  it("throws when pet status is 'deceased'", async () => {
    vi.resetModules();
    mockRequireTitularAccess.mockResolvedValue(makePetAccessSuccess("deceased"));

    const { enableTier2PublicAction } = await import("@/app/actions/tier2-public");
    await expect(enableTier2PublicAction(PUBLIC_TOKEN)).rejects.toThrow(/fallecida/i);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  // ── Duration mapping ───────────────────────────────────────────────────────

  it("24h duration sets tier2PublicEnabledUntil to ~24h from now and permanent=false", async () => {
    vi.resetModules();
    mockRequireTitularAccess.mockResolvedValue(makePetAccessSuccess());

    const { enableTier2PublicAction } = await import("@/app/actions/tier2-public");
    const before = Date.now();
    await enableTier2PublicAction(PUBLIC_TOKEN, makeFormData("24h"));
    const after = Date.now();

    expect(capturedSetPayload).not.toBeNull();
    expect(capturedSetPayload!.tier2PublicPermanent).toBe(false);
    const until = capturedSetPayload!.tier2PublicEnabledUntil as Date;
    expect(until).toBeInstanceOf(Date);
    // Must be within the expected 24h window (± 5s tolerance).
    expect(until.getTime()).toBeGreaterThanOrEqual(before + DAY_MS - 5_000);
    expect(until.getTime()).toBeLessThanOrEqual(after + DAY_MS + 5_000);
  });

  it("7d duration sets tier2PublicEnabledUntil to ~7 days from now", async () => {
    vi.resetModules();
    mockRequireTitularAccess.mockResolvedValue(makePetAccessSuccess());

    const { enableTier2PublicAction } = await import("@/app/actions/tier2-public");
    const before = Date.now();
    await enableTier2PublicAction(PUBLIC_TOKEN, makeFormData("7d"));
    const after = Date.now();

    expect(capturedSetPayload!.tier2PublicPermanent).toBe(false);
    const until = capturedSetPayload!.tier2PublicEnabledUntil as Date;
    expect(until.getTime()).toBeGreaterThanOrEqual(before + 7 * DAY_MS - 5_000);
    expect(until.getTime()).toBeLessThanOrEqual(after + 7 * DAY_MS + 5_000);
  });

  it("30d duration sets tier2PublicEnabledUntil to ~30 days from now", async () => {
    vi.resetModules();
    mockRequireTitularAccess.mockResolvedValue(makePetAccessSuccess());

    const { enableTier2PublicAction } = await import("@/app/actions/tier2-public");
    const before = Date.now();
    await enableTier2PublicAction(PUBLIC_TOKEN, makeFormData("30d"));
    const after = Date.now();

    expect(capturedSetPayload!.tier2PublicPermanent).toBe(false);
    const until = capturedSetPayload!.tier2PublicEnabledUntil as Date;
    expect(until.getTime()).toBeGreaterThanOrEqual(before + 30 * DAY_MS - 5_000);
    expect(until.getTime()).toBeLessThanOrEqual(after + 30 * DAY_MS + 5_000);
  });

  it("'siempre' duration sets tier2PublicPermanent=true and tier2PublicEnabledUntil=null", async () => {
    vi.resetModules();
    mockRequireTitularAccess.mockResolvedValue(makePetAccessSuccess());

    const { enableTier2PublicAction } = await import("@/app/actions/tier2-public");
    await enableTier2PublicAction(PUBLIC_TOKEN, makeFormData("siempre"));

    expect(capturedSetPayload!.tier2PublicPermanent).toBe(true);
    expect(capturedSetPayload!.tier2PublicEnabledUntil).toBeNull();
  });

  it("unknown duration falls back to 24h window", async () => {
    vi.resetModules();
    mockRequireTitularAccess.mockResolvedValue(makePetAccessSuccess());

    const { enableTier2PublicAction } = await import("@/app/actions/tier2-public");
    const before = Date.now();
    await enableTier2PublicAction(PUBLIC_TOKEN, makeFormData("999d"));
    const after = Date.now();

    expect(capturedSetPayload!.tier2PublicPermanent).toBe(false);
    const until = capturedSetPayload!.tier2PublicEnabledUntil as Date;
    // Falls back to 24h.
    expect(until.getTime()).toBeGreaterThanOrEqual(before + DAY_MS - 5_000);
    expect(until.getTime()).toBeLessThanOrEqual(after + DAY_MS + 5_000);
  });

  it("no FormData falls back to 24h window (back-compat)", async () => {
    vi.resetModules();
    mockRequireTitularAccess.mockResolvedValue(makePetAccessSuccess());

    const { enableTier2PublicAction } = await import("@/app/actions/tier2-public");
    const before = Date.now();
    await enableTier2PublicAction(PUBLIC_TOKEN);
    const after = Date.now();

    expect(capturedSetPayload!.tier2PublicPermanent).toBe(false);
    const until = capturedSetPayload!.tier2PublicEnabledUntil as Date;
    expect(until.getTime()).toBeGreaterThanOrEqual(before + DAY_MS - 5_000);
    expect(until.getTime()).toBeLessThanOrEqual(after + DAY_MS + 5_000);
  });

  // ── Idempotency guards (projection-writes audit §6) ────────────────────────

  it("double-submit no-op: already permanent + 'siempre' again → no write", async () => {
    vi.resetModules();
    const access = makePetAccessSuccess();
    (access.pet as Record<string, unknown>).tier2PublicPermanent = true;
    (access.pet as Record<string, unknown>).tier2PublicEnabledUntil = null;
    mockRequireTitularAccess.mockResolvedValue(access);

    const { enableTier2PublicAction } = await import("@/app/actions/tier2-public");
    await enableTier2PublicAction(PUBLIC_TOKEN, makeFormData("siempre"));

    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("double-submit no-op: existing 24h window within the duplicate tolerance → no re-window", async () => {
    vi.resetModules();
    const access = makePetAccessSuccess();
    // First click landed 5 seconds ago: window ends at now + 24h - 5s.
    (access.pet as Record<string, unknown>).tier2PublicPermanent = false;
    (access.pet as Record<string, unknown>).tier2PublicEnabledUntil = new Date(
      Date.now() + DAY_MS - 5_000,
    );
    mockRequireTitularAccess.mockResolvedValue(access);

    const { enableTier2PublicAction } = await import("@/app/actions/tier2-public");
    await enableTier2PublicAction(PUBLIC_TOKEN, makeFormData("24h"));

    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("NOT a no-op: deliberate re-window hours later still extends", async () => {
    vi.resetModules();
    const access = makePetAccessSuccess();
    // Existing window ends in 1 hour — re-enabling 24h is a real extension.
    (access.pet as Record<string, unknown>).tier2PublicPermanent = false;
    (access.pet as Record<string, unknown>).tier2PublicEnabledUntil = new Date(
      Date.now() + 60 * 60 * 1000,
    );
    mockRequireTitularAccess.mockResolvedValue(access);

    const { enableTier2PublicAction } = await import("@/app/actions/tier2-public");
    await enableTier2PublicAction(PUBLIC_TOKEN, makeFormData("24h"));

    expect(mockDb.update).toHaveBeenCalledOnce();
    expect(capturedSetPayload!.tier2PublicPermanent).toBe(false);
  });

  it("NOT a no-op: permanent pet downgrading to a bounded window still writes", async () => {
    vi.resetModules();
    const access = makePetAccessSuccess();
    (access.pet as Record<string, unknown>).tier2PublicPermanent = true;
    (access.pet as Record<string, unknown>).tier2PublicEnabledUntil = null;
    mockRequireTitularAccess.mockResolvedValue(access);

    const { enableTier2PublicAction } = await import("@/app/actions/tier2-public");
    await enableTier2PublicAction(PUBLIC_TOKEN, makeFormData("24h"));

    expect(mockDb.update).toHaveBeenCalledOnce();
    expect(capturedSetPayload!.tier2PublicPermanent).toBe(false);
  });
});

describe("revokeTier2PublicAction", () => {
  beforeEach(() => {
    capturedSetPayload = null;
    updateChain.set.mockClear();
    updateChain.where.mockClear();
    mockDb.update.mockClear();
  });

  // ── Access gate ────────────────────────────────────────────────────────────

  it("throws when requirePetAccess returns ok:false", async () => {
    vi.resetModules();
    mockRequireTitularAccess.mockResolvedValue({ ok: false, error: "Sin permisos." });

    const { revokeTier2PublicAction } = await import("@/app/actions/tier2-public");
    await expect(revokeTier2PublicAction(PUBLIC_TOKEN)).rejects.toThrow("Sin permisos.");
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  // ── Revoke clears both columns ─────────────────────────────────────────────

  it("clears tier2PublicEnabledUntil and sets tier2PublicPermanent=false", async () => {
    vi.resetModules();
    mockRequireTitularAccess.mockResolvedValue(makePetAccessSuccess());

    const { revokeTier2PublicAction } = await import("@/app/actions/tier2-public");
    await revokeTier2PublicAction(PUBLIC_TOKEN);

    expect(capturedSetPayload).not.toBeNull();
    expect(capturedSetPayload!.tier2PublicEnabledUntil).toBeNull();
    expect(capturedSetPayload!.tier2PublicPermanent).toBe(false);
  });

  it("revoke works even on a deceased pet (no deceased guard on revoke path)", async () => {
    vi.resetModules();
    mockRequireTitularAccess.mockResolvedValue(makePetAccessSuccess("deceased"));

    const { revokeTier2PublicAction } = await import("@/app/actions/tier2-public");
    await expect(revokeTier2PublicAction(PUBLIC_TOKEN)).resolves.toBeUndefined();

    expect(capturedSetPayload!.tier2PublicEnabledUntil).toBeNull();
    expect(capturedSetPayload!.tier2PublicPermanent).toBe(false);
  });
});
