// Unit-style tests for the form-action wrappers around replaceMicrochipForUser.
//
// These assert that each wrapper correctly:
//   1. Rejects reasons outside its actor's allowed set.
//   2. Passes the correct actorContext.kind to the inner writer.
//   3. Returns the N3 `redirectTo` on success instead of redirect()-ing.
//
// WHAT THE SUCCESS TESTS USED TO ASSERT, AND WHY IT WAS A LIE
// ---------------------------------------------------------------------------
// Five tests here ended their happy path with:
//
//     await expect(action(...)).rejects.toThrow("REDIRECT");
//
// The string comes from this file's own mock of next/navigation, which makes
// redirect() throw. So the assertion read "the action called redirect()" —
// dressed up as a success check, because redirect() throwing is how it works.
//
// That is the exact behaviour nav contract N3 exists to forbid. Next 15.5.x's
// App Router resolves a Server Action's redirect and then drops the client
// transition: the chip replacement COMMITS, the URL never changes, and the vet
// or admin is left looking at a form that appears to have done nothing
// (engram #621/#622; lib/ui/full-page-action-nav.ts). Three actions still did
// it, and these five tests were the reason nobody noticed — the suite was green
// because it demanded the broken thing.
//
// They now assert the contract: the action RESOLVES with `redirectTo`, and
// redirect() is never called.
//
// The full allowed-reasons matrix and all writer side-effects (event insert,
// case opening, notifications, audit log) are already covered by
// microchip-replaced.test.ts.  We mock replaceMicrochipForUser here so these
// tests run without a live DB and complete in milliseconds.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Real module (NOT mocked) — the plausibility guard's AR-day compare needs the
// genuine parseDateInput noon-UTC anchor plus isoDateInAr/todayIsoInAr.
import { todayIsoInAr } from "@/lib/utils/format";

// ---------------------------------------------------------------------------
// Stable fixture values
// ---------------------------------------------------------------------------

const OWNER_USER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const PET_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const PET_TOKEN = "test-pet-token";
const CHIP = "985141000000001";
const VET_USER_ID = "aaaaaaaa-0000-0000-0000-000000000002";
const ORG_ID = "cccccccc-0000-0000-0000-000000000001";
const ORG_TOKEN = "test-org-token";
// AR calendar day — the plausibility guard compares ARGENTINE days, and the
// UTC day is already "tomorrow" in AR between 21:00 and 24:00 AR.
const TODAY = todayIsoInAr();
const TOMORROW_AR = (() => {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
})();

// ---------------------------------------------------------------------------
// Mock: inner writer
// ---------------------------------------------------------------------------

const mockReplaceMicrochipForUser = vi.fn();
vi.mock("@/src/modules/pets/application/microchip/replace-microchip", () => ({
  replaceMicrochipForUser: (...args: unknown[]) => mockReplaceMicrochipForUser(...args),
}));

// ---------------------------------------------------------------------------
// Mock: owner-path session
// ---------------------------------------------------------------------------

vi.mock("@/lib/infra/pets", () => ({
  requireOwnedPetByToken: vi.fn(async () => ({
    user: { id: OWNER_USER_ID },
    pet: { id: PET_ID, publicToken: PET_TOKEN, microchipId: CHIP, dateOfBirth: "2020-01-01" },
    accessPath: "owner" as const,
    organization: null,
  })),
}));

// ---------------------------------------------------------------------------
// Mock: org + admin auth guards + capabilities
// ---------------------------------------------------------------------------

vi.mock("@/lib/infra/auth-guards", () => ({
  requireOrgAccessByToken: vi.fn(async () => ({
    user: { id: VET_USER_ID },
    organization: { id: ORG_ID, displayName: "Clinica Test" },
    membership: { id: "mem-001", role: "vet_individual" },
    supabase: {},
  })),
  requireAdminOrRedirect: vi.fn(async () => ({
    user: { id: "admin-user-id" },
    profile: {
      id: "admin-user-id",
      role: "admin",
      accountType: "institutional",
      deactivatedAt: null,
    },
    supabase: {},
  })),
}));

vi.mock("@/src/modules/organizations/infrastructure/authz-resolver", () => ({
  getGrantedCapabilities: vi.fn(async () => new Set(["event.write", "pet.read_held"])),
}));

// ---------------------------------------------------------------------------
// Mock: DB queries
// Vet path queries: pets + ownerships join (custody check)
// Admin path query: pets only (by publicToken)
// Both return the same pet fixture — callers can't distinguish the shape.
// ---------------------------------------------------------------------------

const PET_FIXTURE = {
  id: PET_ID,
  publicToken: PET_TOKEN,
  microchipId: CHIP,
  name: "Test",
  // Feeds the plausibility guard's BEFORE_BIRTH leg (PO 2026-07-16).
  dateOfBirth: "2020-01-01",
};
// Vet action uses: db.select({ pet: pets, role: ownerships.role }).from(...).innerJoin(...).where(...).limit(1)
// → first element of the result array is { pet: ..., role: ... }
const VET_ROW = { pet: PET_FIXTURE, role: "shelter_custody" };

// DB mock returns the vet-shaped row by default (used by vet + admin paths).
// Admin action destructures the array directly: const [pet] = await db...
// so it receives VET_ROW as `pet`. Admin action then accesses `pet.microchipId`
// which resolves via VET_ROW.microchipId (undefined). To handle both actors with
// one mock, we put PET_FIXTURE fields directly on VET_ROW so both access paths work:
//   vet: const { pet } = petRow  → needs petRow.pet
//   admin: const [pet] = ...      → needs pet.microchipId, pet.id, etc.
// Solution: make the returned object work for both by attaching pet fields AND a pet sub-key.
const DUAL_ROW = Object.assign(Object.create(PET_FIXTURE), {
  pet: PET_FIXTURE,
  role: "shelter_custody",
});

vi.mock("@/db", () => {
  const chain = {
    select: vi.fn(),
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(async () => [DUAL_ROW]),
  };
  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);

  return {
    db: chain,
    ownerships: {},
    pets: {},
    petIdentifications: {},
  };
});

// ARCH-S: form actions now call fetchActiveIdentifications to get the current chip.
// Mock it to return a pre-existing chip so the "accepts" tests reach replaceMicrochipForUser.
vi.mock("@/lib/infra/pet-identifiers", () => ({
  fetchActiveIdentifications: vi.fn(async () => ({
    microchip: {
      code: CHIP,
      isoCountryCode: "985",
      recordedAt: null,
      recordedByLabel: null,
      implantationSite: null,
    },
    tattoo: null,
  })),
}));

// ---------------------------------------------------------------------------
// Mock: format helpers + navigation
// ---------------------------------------------------------------------------

// NOTE: @/lib/utils/format is intentionally NOT mocked anymore — the
// plausibility guard (PO 2026-07-16) needs the real noon-UTC parseDateInput
// and the AR-day helpers.

// redirect() still throws here on purpose. Nothing under test may call it any
// more (contract N3), so the throw turns a regression into a loud failure
// instead of a quiet one — and `expectNavigatesTo` asserts it stayed unused.
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("REDIRECT");
  }),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

/**
 * Reset BOTH mocks each test. The redirect spy used to be left alone, so once
 * any test tripped it every later `not.toHaveBeenCalled()` inherited the call
 * and reported a failure in the wrong test — the leak turned one regression
 * into four confusing ones (observed while mutation-testing this file).
 */
async function resetActionMocks(): Promise<void> {
  mockReplaceMicrochipForUser.mockReset();
  vi.mocked((await import("next/navigation")).redirect).mockClear();
}

/**
 * Assert the N3 success shape: the action RESOLVED (it did not throw its way
 * out through redirect()) and handed the form the exact destination.
 *
 * Both halves are load-bearing. Checking only `redirectTo` would still pass if
 * the action ALSO called redirect() first — which is the failure mode, not a
 * detail — so the redirect mock is asserted unused. And the destination is
 * pinned to the full string: a wrong-but-present URL sends whoever just
 * replaced a chip to the wrong screen, which reads as the write having failed.
 */
async function expectNavigatesTo(
  promise: Promise<{ error: string | null; ok?: boolean; redirectTo?: string }>,
  destination: string,
): Promise<void> {
  const { redirect } = await import("next/navigation");
  await expect(promise).resolves.toEqual({ error: null, ok: true, redirectTo: destination });
  expect(redirect).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// Owner action
// ---------------------------------------------------------------------------

describe("replaceMicrochipOwnerAction — reason validation", () => {
  beforeEach(resetActionMocks);

  it("rejects fraud_detected (not in owner reason set)", async () => {
    const { replaceMicrochipOwnerAction } = await import(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/microchip-reemplazo/action"
    );

    const fd = makeFormData({
      reason: "fraud_detected",
      newChipNumber: "985141000000099",
      replacedAt: TODAY,
    });
    const result = await replaceMicrochipOwnerAction(PET_TOKEN, { error: null }, fd);

    expect(result.error).toBeTruthy();
    expect(mockReplaceMicrochipForUser).not.toHaveBeenCalled();
  });

  it("rejects duplicate_detected (not in owner reason set)", async () => {
    const { replaceMicrochipOwnerAction } = await import(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/microchip-reemplazo/action"
    );

    const fd = makeFormData({
      reason: "duplicate_detected",
      newChipNumber: "985141000000099",
      replacedAt: TODAY,
    });
    const result = await replaceMicrochipOwnerAction(PET_TOKEN, { error: null }, fd);

    expect(result.error).toBeTruthy();
    expect(mockReplaceMicrochipForUser).not.toHaveBeenCalled();
  });

  it("accepts damaged + new chip and passes actorContext=owner", async () => {
    mockReplaceMicrochipForUser.mockResolvedValue({ ok: true, eventId: "evt-1", caseId: null });

    const { replaceMicrochipOwnerAction } = await import(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/microchip-reemplazo/action"
    );

    const fd = makeFormData({
      reason: "damaged",
      newChipNumber: "985141000000099",
      replacedAt: TODAY,
    });

    await expectNavigatesTo(
      replaceMicrochipOwnerAction(PET_TOKEN, { error: null }, fd),
      `/mis-mascotas/${PET_TOKEN}`,
    );

    expect(mockReplaceMicrochipForUser).toHaveBeenCalledOnce();
    const [, input] = mockReplaceMicrochipForUser.mock.calls[0] as [
      string,
      { actorContext: { kind: string }; reason: string; newChipNumber: string | null },
    ];
    expect(input.actorContext.kind).toBe("owner");
    expect(input.reason).toBe("damaged");
    expect(input.newChipNumber).toBe("985141000000099");
  });

  it("rejects empty newChipNumber when reason is damaged (not a revocation reason)", async () => {
    const { replaceMicrochipOwnerAction } = await import(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/microchip-reemplazo/action"
    );

    const fd = makeFormData({ reason: "damaged", newChipNumber: "", replacedAt: TODAY });
    const result = await replaceMicrochipOwnerAction(PET_TOKEN, { error: null }, fd);

    expect(result.error).toBeTruthy();
    expect(mockReplaceMicrochipForUser).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Vet action
// ---------------------------------------------------------------------------

describe("replaceMicrochipVetAction — reason validation", () => {
  beforeEach(resetActionMocks);

  it("accepts duplicate_detected and passes actorContext=vet_in_org", async () => {
    mockReplaceMicrochipForUser.mockResolvedValue({ ok: true, eventId: "evt-2", caseId: "case-1" });

    const { replaceMicrochipVetAction } = await import(
      "@/app/org/[orgToken]/mascotas/[publicToken]/microchip/reemplazar/action"
    );

    const fd = makeFormData({
      reason: "duplicate_detected",
      newChipNumber: "985141000000099",
      replacedAt: TODAY,
    });

    await expectNavigatesTo(
      replaceMicrochipVetAction(ORG_TOKEN, PET_TOKEN, { error: null }, fd),
      `/org/${ORG_TOKEN}/mascotas`,
    );

    expect(mockReplaceMicrochipForUser).toHaveBeenCalledOnce();
    const [, input] = mockReplaceMicrochipForUser.mock.calls[0] as [
      string,
      { actorContext: { kind: string; organizationId: string } },
    ];
    expect(input.actorContext.kind).toBe("vet_in_org");
    expect(input.actorContext.organizationId).toBe(ORG_ID);
  });

  it("rejects fraud_detected (not in vet reason set)", async () => {
    const { replaceMicrochipVetAction } = await import(
      "@/app/org/[orgToken]/mascotas/[publicToken]/microchip/reemplazar/action"
    );

    const fd = makeFormData({
      reason: "fraud_detected",
      newChipNumber: "985141000000099",
      replacedAt: TODAY,
    });
    const result = await replaceMicrochipVetAction(ORG_TOKEN, PET_TOKEN, { error: null }, fd);

    expect(result.error).toBeTruthy();
    expect(mockReplaceMicrochipForUser).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Admin action
// ---------------------------------------------------------------------------

describe("replaceMicrochipAdminAction — reason validation", () => {
  beforeEach(resetActionMocks);

  it("accepts fraud_detected with notes and passes actorContext=admin", async () => {
    mockReplaceMicrochipForUser.mockResolvedValue({ ok: true, eventId: "evt-3", caseId: "case-2" });

    const { replaceMicrochipAdminAction } = await import(
      "@/app/admin/observaciones/[publicToken]/microchip/reemplazar/action"
    );

    const fd = makeFormData({
      reason: "fraud_detected",
      newChipNumber: "",
      replacedAt: TODAY,
      notes: "Chip fraudulento — expediente policial 12345.",
    });

    await expectNavigatesTo(
      replaceMicrochipAdminAction(PET_TOKEN, { error: null }, fd),
      "/admin/observaciones",
    );

    expect(mockReplaceMicrochipForUser).toHaveBeenCalledOnce();
    const [, input] = mockReplaceMicrochipForUser.mock.calls[0] as [
      string,
      { actorContext: { kind: string }; reason: string },
    ];
    expect(input.actorContext.kind).toBe("admin");
    expect(input.reason).toBe("fraud_detected");
  });

  it("rejects fraud_detected without notes (mandatory audit trail)", async () => {
    const { replaceMicrochipAdminAction } = await import(
      "@/app/admin/observaciones/[publicToken]/microchip/reemplazar/action"
    );

    const fd = makeFormData({
      reason: "fraud_detected",
      newChipNumber: "",
      replacedAt: TODAY,
      notes: "",
    });
    const result = await replaceMicrochipAdminAction(PET_TOKEN, { error: null }, fd);

    expect(result.error).toBeTruthy();
    expect(mockReplaceMicrochipForUser).not.toHaveBeenCalled();
  });

  it("accepts all owner-compatible reasons (e.g. damaged)", async () => {
    mockReplaceMicrochipForUser.mockResolvedValue({ ok: true, eventId: "evt-4", caseId: null });

    const { replaceMicrochipAdminAction } = await import(
      "@/app/admin/observaciones/[publicToken]/microchip/reemplazar/action"
    );

    const fd = makeFormData({
      reason: "damaged",
      newChipNumber: "985141000000099",
      replacedAt: TODAY,
    });

    await expectNavigatesTo(
      replaceMicrochipAdminAction(PET_TOKEN, { error: null }, fd),
      "/admin/observaciones",
    );

    expect(mockReplaceMicrochipForUser).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Date plausibility (PO 2026-07-16) — same-day AR accepted, tomorrow rejected.
// The "accepts" leg is already exercised by the acceptance tests above (their
// replacedAt is TODAY in AR); these assert the rejection copy per actor.
// ---------------------------------------------------------------------------

describe("replaceMicrochip* actions — date plausibility", () => {
  beforeEach(resetActionMocks);

  it("owner action rejects tomorrow's AR date", async () => {
    const { replaceMicrochipOwnerAction } = await import(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/microchip-reemplazo/action"
    );
    const fd = makeFormData({
      reason: "damaged",
      newChipNumber: "985141000000099",
      replacedAt: TOMORROW_AR,
    });
    const result = await replaceMicrochipOwnerAction(PET_TOKEN, { error: null }, fd);
    expect(result.error).toBe("La fecha no puede ser futura.");
    expect(mockReplaceMicrochipForUser).not.toHaveBeenCalled();
  });

  it("owner action accepts today's AR date", async () => {
    mockReplaceMicrochipForUser.mockResolvedValue({ ok: true, eventId: "evt-5", caseId: null });
    const { replaceMicrochipOwnerAction } = await import(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/microchip-reemplazo/action"
    );
    const fd = makeFormData({
      reason: "damaged",
      newChipNumber: "985141000000099",
      replacedAt: TODAY,
    });
    await expectNavigatesTo(
      replaceMicrochipOwnerAction(PET_TOKEN, { error: null }, fd),
      `/mis-mascotas/${PET_TOKEN}`,
    );
    expect(mockReplaceMicrochipForUser).toHaveBeenCalledOnce();
  });

  it("vet action rejects tomorrow's AR date", async () => {
    const { replaceMicrochipVetAction } = await import(
      "@/app/org/[orgToken]/mascotas/[publicToken]/microchip/reemplazar/action"
    );
    const fd = makeFormData({
      reason: "damaged",
      newChipNumber: "985141000000099",
      replacedAt: TOMORROW_AR,
    });
    const result = await replaceMicrochipVetAction(ORG_TOKEN, PET_TOKEN, { error: null }, fd);
    expect(result.error).toBe("La fecha no puede ser futura.");
    expect(mockReplaceMicrochipForUser).not.toHaveBeenCalled();
  });

  it("admin action rejects tomorrow's AR date", async () => {
    const { replaceMicrochipAdminAction } = await import(
      "@/app/admin/observaciones/[publicToken]/microchip/reemplazar/action"
    );
    const fd = makeFormData({
      reason: "damaged",
      newChipNumber: "985141000000099",
      replacedAt: TOMORROW_AR,
    });
    const result = await replaceMicrochipAdminAction(PET_TOKEN, { error: null }, fd);
    expect(result.error).toBe("La fecha no puede ser futura.");
    expect(mockReplaceMicrochipForUser).not.toHaveBeenCalled();
  });

  it("owner action rejects a replacedAt before the pet's date of birth", async () => {
    const { replaceMicrochipOwnerAction } = await import(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/microchip-reemplazo/action"
    );
    const fd = makeFormData({
      reason: "damaged",
      newChipNumber: "985141000000099",
      replacedAt: "2019-12-31",
    });
    const result = await replaceMicrochipOwnerAction(PET_TOKEN, { error: null }, fd);
    expect(result.error).toMatch(/anterior a la fecha de nacimiento/i);
    expect(mockReplaceMicrochipForUser).not.toHaveBeenCalled();
  });
});
