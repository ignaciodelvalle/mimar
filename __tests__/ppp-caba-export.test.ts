// Tests for PPP CABA export (Chunk F, F2).
//
// Unit tests: generatePppCabaPdf (smoke — renders without throwing), CABA_PROVINCE constant.
// Integration tests: generatePppExportAction against local DB (Storage mocked).

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { dniLast4, hashDni } from "@/lib/utils/dni-hash";

import { generatePppExportAction } from "@/app/actions/ppp-export-caba";
import { auditLog, db, ownerships, pets, profiles } from "@/db";
import { CABA_PROVINCE, generatePppCabaPdf } from "@/lib/analytics/ppp-exports";
import * as authGuards from "@/lib/infra/auth-guards";
import * as supabaseServer from "@/lib/supabase/server";
import { withMutationOverride } from "./_helpers/db-overrides";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

// Service-role storage client (migration 0172) — the export buckets have no
// authenticated policy, so upload/sign run as service role.
const adminHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminHolder.current,
}));
vi.mock("@/lib/infra/auth-guards", () => ({
  requireUserOrRedirect: vi.fn(),
  requireAdminOrGovtOrRedirect: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Unit tests — CABA_PROVINCE and generatePppCabaPdf
// ---------------------------------------------------------------------------

describe("CABA_PROVINCE", () => {
  it("is a non-empty string matching the canonical CABA name", () => {
    expect(CABA_PROVINCE).toBe("CABA");
  });
});

describe("generatePppCabaPdf — smoke render", () => {
  it("renders a PDF buffer without throwing (verified owner — masked DNI)", async () => {
    // A7 fix: ownerDniNumber must be the masked string, not a full DNI.
    // The caller (ppp-export-caba.ts) derives this from dniVerified + dniLast4.
    const dto = {
      petName: "TestDog",
      petPublicToken: "DIM-PPP-TEST",
      petSpecies: "dog",
      petBreed: "Pit Bull",
      petDateOfBirth: "2022-03-15",
      petMicrochipId: "999000000000010",
      petPotentiallyDangerousBreed: true,
      ownerDisplayName: "María López",
      ownerDniNumber: "DNI ····3456 — verificado por Mi Argentina",
      ownerEmail: "maria@example.com",
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Palermo",
      exportGeneratedAt: new Date().toLocaleString("es-AR"),
    };

    const bytes = await generatePppCabaPdf(dto);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(1000); // a real PDF is always > 1 KB
  });

  it("renders without DNI (null → fallback text)", async () => {
    const dto = {
      petName: "NoDni",
      petPublicToken: "DIM-PPP-NODNI",
      petSpecies: "dog",
      petBreed: null,
      petDateOfBirth: null,
      petMicrochipId: null,
      petPotentiallyDangerousBreed: true,
      ownerDisplayName: "Carlos García",
      ownerDniNumber: null,
      ownerEmail: "carlos@example.com",
      jurisdictionProvince: "CABA",
      jurisdictionLocality: null,
      exportGeneratedAt: new Date().toLocaleString("es-AR"),
    };

    const bytes = await generatePppCabaPdf(dto);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — ownerDniNumber derivation (A7 fix)
//
// Verifies the two derivation paths without hitting the DB:
//   - dniVerified=true  + dniLast4 present → masked "DNI ····XXXX — verificado por Mi Argentina"
//   - dniVerified=false (or absent)         → null → PDF renderer shows the organismo fallback
// ---------------------------------------------------------------------------

describe("ownerDniNumber derivation — masked-DNI format (A7)", () => {
  /**
   * Inline helper that mirrors exactly what ppp-export-caba.ts does at DTO build time.
   * If the derivation logic in the action changes, this helper must match.
   */
  function deriveOwnerDniNumber(
    profile: { dniVerified: boolean; dniLast4: string | null } | undefined,
  ): string | null {
    return profile?.dniVerified && profile.dniLast4
      ? `DNI ····${profile.dniLast4} — verificado por Mi Argentina`
      : null;
  }

  it("verified owner with last4 → masked string with verification source", () => {
    const result = deriveOwnerDniNumber({ dniVerified: true, dniLast4: "3456" });
    expect(result).toBe("DNI ····3456 — verificado por Mi Argentina");
    // Privacy: must not contain any 8-digit sequence (full DNI never exposed).
    expect(result).not.toMatch(/\d{8}/);
  });

  it("unverified owner with last4 → null (PDF renderer shows organismo fallback)", () => {
    const result = deriveOwnerDniNumber({ dniVerified: false, dniLast4: "3456" });
    expect(result).toBeNull();
  });

  it("verified owner with no last4 → null", () => {
    const result = deriveOwnerDniNumber({ dniVerified: true, dniLast4: null });
    expect(result).toBeNull();
  });

  it("undefined profile → null", () => {
    const result = deriveOwnerDniNumber(undefined);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration tests — generatePppExportAction (Storage mocked, DB real)
// ---------------------------------------------------------------------------

const PPP_PET_TOKEN_CABA = "DIM-PPP-CABA01";
const PPP_PET_TOKEN_PROV = "DIM-PPP-PROV01";
// A7: second CABA token for the unverified-DNI owner path.
const PPP_PET_TOKEN_CABA_NODNI = "DIM-PPP-CABA02";
const MOCK_OWNER_ID = "eeeeeeee-0000-0000-0000-000000000005";
// A7: second owner — has dniLast4 but dniVerified = false.
const MOCK_OWNER_NODNI_ID = "eeeeeeee-0000-0000-0000-000000000007";
const MOCK_SIGNED_URL = "https://storage.example.com/ppp-exports/test.pdf?token=mock";

let petIdCaba: string;
let petIdProv: string;
// A7: CABA pet owned by the unverified-DNI owner.
let petIdCabaNoDni: string;

const mockCreateClient = vi.mocked(supabaseServer.createClient);
const mockRequireUserOrRedirect = vi.mocked(authGuards.requireUserOrRedirect);

function buildSupabaseMock(userId = MOCK_OWNER_ID, email = "ppp-owner@dim-test.local") {
  const mock = {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: userId, email } },
      }),
    },
    storage: {
      from: vi.fn().mockReturnValue({
        upload: vi.fn().mockResolvedValue({
          data: { path: "ppp-exports/test.pdf" },
          error: null,
        }),
        createSignedUrl: vi.fn().mockResolvedValue({
          data: { signedUrl: MOCK_SIGNED_URL },
          error: null,
        }),
      }),
    },
  };
  adminHolder.current = mock;
  return mock;
}

async function purgeFixtures() {
  // Note: audit_log is append-only (DB trigger blocks DELETE) — do NOT attempt
  // to delete audit_log rows here. Tests scope queries by actorUserId + action.
  await withMutationOverride(async (tx) => {
    for (const token of [PPP_PET_TOKEN_CABA, PPP_PET_TOKEN_PROV, PPP_PET_TOKEN_CABA_NODNI]) {
      await tx.execute(
        sql`DELETE FROM ownerships WHERE pet_id IN (
          SELECT id FROM pets WHERE public_token = ${token}
        )`,
      );
      await tx.execute(sql`DELETE FROM pets WHERE public_token = ${token}`);
    }
  });
}

beforeAll(async () => {
  await purgeFixtures();

  // A7: verified owner — dniVerified = true so the action emits the masked string.
  await db
    .insert(profiles)
    .values({
      id: MOCK_OWNER_ID,
      displayName: "PPP Owner Test",
      role: "owner",
      accountType: "personal",
      // Wave 5 Item 25a: hash + last4 only, no plaintext.
      dniHash: hashDni("31234567"),
      dniLast4: dniLast4("31234567"),
      dniVerified: true,
    })
    .onConflictDoNothing({ target: profiles.id });

  // A7: unverified owner — dniLast4 present but dniVerified = false.
  // The action must emit null → renderer shows the "organismo" fallback.
  await db
    .insert(profiles)
    .values({
      id: MOCK_OWNER_NODNI_ID,
      displayName: "PPP No DNI Owner",
      role: "owner",
      accountType: "personal",
      dniHash: hashDni("29000001"),
      dniLast4: dniLast4("29000001"),
      dniVerified: false,
    })
    .onConflictDoNothing({ target: profiles.id });

  // CABA pet (PPP = true, CABA jurisdiction).
  const [petCaba] = await db
    .insert(pets)
    .values({
      publicToken: PPP_PET_TOKEN_CABA,
      name: "PitBullCABA",
      species: "dog",
      sex: "male",
      breed: "Pit Bull Terrier",
      potentiallyDangerousBreed: true,
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Palermo",
    })
    .returning();
  petIdCaba = petCaba.id;

  await db.insert(ownerships).values({
    petId: petIdCaba,
    ownerUserId: MOCK_OWNER_ID,
    role: "owner",
    startedAt: new Date(),
  });

  // Prov BA pet (PPP = true, non-CABA jurisdiction).
  const [petProv] = await db
    .insert(pets)
    .values({
      publicToken: PPP_PET_TOKEN_PROV,
      name: "PitBullProv",
      species: "dog",
      sex: "female",
      breed: "Pit Bull Terrier",
      potentiallyDangerousBreed: true,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    })
    .returning();
  petIdProv = petProv.id;

  await db.insert(ownerships).values({
    petId: petIdProv,
    ownerUserId: MOCK_OWNER_ID,
    role: "owner",
    startedAt: new Date(),
  });

  // A7: CABA pet owned by the unverified-DNI owner (dniVerified = false).
  const [petCabaNoDni] = await db
    .insert(pets)
    .values({
      publicToken: PPP_PET_TOKEN_CABA_NODNI,
      name: "PitBullNoDni",
      species: "dog",
      sex: "male",
      breed: "Pit Bull Terrier",
      potentiallyDangerousBreed: true,
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Flores",
    })
    .returning();
  petIdCabaNoDni = petCabaNoDni.id;

  await db.insert(ownerships).values({
    petId: petIdCabaNoDni,
    ownerUserId: MOCK_OWNER_NODNI_ID,
    role: "owner",
    startedAt: new Date(),
  });
});

afterAll(async () => {
  await purgeFixtures();
});

describe("generatePppExportAction — CABA happy path", () => {
  it("returns signed URL and inserts audit_log for a CABA PPP pet", async () => {
    const supabaseMock = buildSupabaseMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(supabaseMock as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireUserOrRedirect.mockResolvedValue({
      supabase: supabaseMock,
      user: { id: MOCK_OWNER_ID },
    } as any);

    const result = await generatePppExportAction(PPP_PET_TOKEN_CABA);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signedUrl).toBe(MOCK_SIGNED_URL);

    // Audit log entry created.
    const [logRow] = await db
      .select({ payload: auditLog.payload, action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.actorUserId, MOCK_OWNER_ID))
      .orderBy(auditLog.performedAt)
      .limit(1);

    expect(logRow.action).toBe("ppp_export_generated");
    const payload = logRow.payload as Record<string, unknown>;
    expect(payload.petPublicToken).toBe(PPP_PET_TOKEN_CABA);
    expect(payload.targetJurisdiction).toBe("caba");
  });
});

// A7: integration tests for both DNI derivation paths at the action level.
describe("generatePppExportAction — verified DNI path (A7)", () => {
  it("completes successfully for a verified-DNI owner (dniVerified=true, dniLast4 present)", async () => {
    // MOCK_OWNER_ID fixture has dniVerified=true + dniLast4="7567" (from "31234567").
    const supabaseMock = buildSupabaseMock(MOCK_OWNER_ID, "ppp-owner@dim-test.local");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(supabaseMock as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireUserOrRedirect.mockResolvedValue({
      supabase: supabaseMock,
      user: { id: MOCK_OWNER_ID },
    } as any);

    const result = await generatePppExportAction(PPP_PET_TOKEN_CABA);
    // The action must succeed — the PDF must render with the masked DNI string.
    expect(result.ok).toBe(true);
  });
});

describe("generatePppExportAction — unverified DNI path (A7)", () => {
  it("completes successfully for an unverified-DNI owner (dniVerified=false)", async () => {
    // MOCK_OWNER_NODNI_ID fixture has dniVerified=false → action emits null →
    // PDF renderer shows the "organismo" fallback — no DNI data exposed at all.
    const supabaseMock = buildSupabaseMock(MOCK_OWNER_NODNI_ID, "ppp-nodni@dim-test.local");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(supabaseMock as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireUserOrRedirect.mockResolvedValue({
      supabase: supabaseMock,
      user: { id: MOCK_OWNER_NODNI_ID },
    } as any);

    const result = await generatePppExportAction(PPP_PET_TOKEN_CABA_NODNI);
    // The action must succeed — null ownerDniNumber is a valid state.
    expect(result.ok).toBe(true);
  });
});

describe("generatePppExportAction — Prov BA rejection", () => {
  it("returns ppp_prov_ba_not_implemented for a Prov BA pet", async () => {
    const supabaseMock = buildSupabaseMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(supabaseMock as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireUserOrRedirect.mockResolvedValue({
      supabase: supabaseMock,
      user: { id: MOCK_OWNER_ID },
    } as any);

    const result = await generatePppExportAction(PPP_PET_TOKEN_PROV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("ppp_prov_ba_not_implemented");
  });

  it("does NOT insert an audit_log row when rejected for Prov BA", async () => {
    const supabaseMock = buildSupabaseMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(supabaseMock as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireUserOrRedirect.mockResolvedValue({
      supabase: supabaseMock,
      user: { id: MOCK_OWNER_ID },
    } as any);

    const [{ before }] = (await db.execute(
      sql`SELECT COUNT(*)::int as before FROM audit_log WHERE action = 'ppp_export_generated' AND payload->>'petPublicToken' = ${PPP_PET_TOKEN_PROV}`,
    )) as Array<{ before: number }>;

    await generatePppExportAction(PPP_PET_TOKEN_PROV);

    const [{ after }] = (await db.execute(
      sql`SELECT COUNT(*)::int as after FROM audit_log WHERE action = 'ppp_export_generated' AND payload->>'petPublicToken' = ${PPP_PET_TOKEN_PROV}`,
    )) as Array<{ after: number }>;

    expect(after).toBe(before); // no new row
  });
});

describe("generatePppExportAction — ownership guard", () => {
  it("returns not_found when the user does not own the pet", async () => {
    const DIFFERENT_USER = "ffffffff-0000-0000-0000-000000000006";
    await db
      .insert(profiles)
      .values({ id: DIFFERENT_USER, displayName: "Other User", role: "owner" })
      .onConflictDoNothing({ target: profiles.id });

    const supabaseMock = {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: DIFFERENT_USER, email: "other@test.local" } },
        }),
      },
      storage: { from: vi.fn().mockReturnValue({ upload: vi.fn(), createSignedUrl: vi.fn() }) },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(supabaseMock as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireUserOrRedirect.mockResolvedValue({
      supabase: supabaseMock,
      user: { id: DIFFERENT_USER },
    } as any);

    const result = await generatePppExportAction(PPP_PET_TOKEN_CABA);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("not_found");
  });
  // Security review 2026-09: the page offers the certificate to the legal
  // owner only, but the use-case accepted ANY open ownership row — a foster
  // calling the action directly got the PDF.
  it("returns not_found for a foster with an open ownership row on the pet", async () => {
    const FOSTER_USER = "ffffffff-0000-0000-0000-000000000008";
    await db
      .insert(profiles)
      .values({ id: FOSTER_USER, displayName: "PPP Foster Test", role: "owner" })
      .onConflictDoNothing({ target: profiles.id });
    await db.insert(ownerships).values({
      petId: petIdCaba,
      ownerUserId: FOSTER_USER,
      role: "foster",
      startedAt: new Date(),
    });

    const supabaseMock = buildSupabaseMock(FOSTER_USER, "ppp-foster@dim-test.local");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(supabaseMock as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireUserOrRedirect.mockResolvedValue({
      supabase: supabaseMock,
      user: { id: FOSTER_USER },
    } as any);

    const result = await generatePppExportAction(PPP_PET_TOKEN_CABA);
    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(supabaseMock.storage.from).not.toHaveBeenCalled();
  });
});
