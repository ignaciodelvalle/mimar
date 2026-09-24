// Tests for the travel doc bundle export (movilidad-jurisdiccional Fase 1,
// Capability 5 — R5.1-R5.4, S14).
//
// Unit: schema version, storage path convention, section builder (per-corridor
// disclaimer + version/effectiveFrom — R5.4 applies the R3.5 disclaimer to the
// exported artifact exactly as on-screen), PDF smoke render.
// Integration: generateTravelExportAction against local DB (Storage mocked,
// ppp-caba-export pattern) — ONE PDF signed URL + ONE travel_export_generated
// audit_log row carrying schemaVersion (S14).

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { auditLog, db, ownerships, petEvents, pets, profiles } from "@/db";
import {
  TRAVEL_EXPORT_SCHEMA_VERSION,
  buildTravelExportPath,
  buildTravelExportSections,
  generateTravelExportPdf,
} from "@/lib/analytics/travel-exports";
import * as authGuards from "@/lib/infra/auth-guards";
import { TRAVEL_DISCLAIMER } from "@/lib/reference/cross-border-corridors";
import * as supabaseServer from "@/lib/supabase/server";
import { generateTravelExport } from "@/src/modules/pets/application/travel-export/generate-travel-export";
import { withMutationOverride } from "./_helpers/db-overrides";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

// Service-role storage client (migration 0172) — `travel-exports` has no
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
// Unit — schema version + path convention (R5.2)
// ---------------------------------------------------------------------------

describe("TRAVEL_EXPORT_SCHEMA_VERSION", () => {
  it("is a non-empty version string", () => {
    expect(TRAVEL_EXPORT_SCHEMA_VERSION.length).toBeGreaterThan(0);
  });
});

describe("buildTravelExportPath — ${token}/travel/${corridor|domestic}/${ts}.pdf", () => {
  it("single corridor → corridor id segment", () => {
    expect(buildTravelExportPath("DIM-AAAA-0001", ["chile"], 1700000000000)).toBe(
      "DIM-AAAA-0001/travel/chile/1700000000000.pdf",
    );
  });

  it("no corridor (domestic move only) → 'domestic' segment", () => {
    expect(buildTravelExportPath("DIM-AAAA-0001", [], 1700000000000)).toBe(
      "DIM-AAAA-0001/travel/domestic/1700000000000.pdf",
    );
  });

  it("multiple corridors → sorted ids joined by '-'", () => {
    expect(buildTravelExportPath("DIM-AAAA-0001", ["uruguay", "chile"], 1700000000000)).toBe(
      "DIM-AAAA-0001/travel/chile-uruguay/1700000000000.pdf",
    );
  });
});

// ---------------------------------------------------------------------------
// Unit — section builder (R5.4: disclaimer + version/effectiveFrom per corridor)
// ---------------------------------------------------------------------------

const DTO = {
  petName: "Rita",
  petPublicToken: "DIM-TRAV-TEST",
  petSpecies: "dog",
  ownerDisplayName: "María López",
  exportGeneratedAt: "04/07/2026 12:00",
  semaforo: "amarillo" as const,
  corridors: [
    {
      id: "chile" as const,
      label: "Chile",
      version: "2026.0",
      effectiveFrom: "2026-07-04",
      sourceUrl: "https://www.sag.gob.cl",
    },
    {
      id: "uruguay" as const,
      label: "Uruguay",
      version: "2026.0",
      effectiveFrom: "2026-07-04",
      sourceUrl: "https://www.gub.uy/ministerio-ganaderia-agricultura-pesca",
    },
  ],
  obligations: [
    {
      key: "required_documents" as const,
      label: "Documentación a presentar",
      state: "A presentar",
      tone: "neutral" as const,
      detail: "health_certificate",
      legalFootnote: "Regla del corredor de viaje · Chile",
      requirementLevel: "warning" as const,
      contributingJurisdictions: ["Chile"],
    },
  ],
};

describe("buildTravelExportSections (R5.4)", () => {
  it("emits one section per corridor, each carrying version + effectiveFrom + disclaimer", () => {
    const sections = buildTravelExportSections(DTO);
    const corridorSections = sections.filter((s) => s.kind === "corridor");
    expect(corridorSections).toHaveLength(2);
    for (const section of corridorSections) {
      const text = section.lines.join("\n");
      expect(text).toContain("2026.0");
      expect(text).toContain("2026-07-04");
      expect(text).toContain(TRAVEL_DISCLAIMER);
    }
  });

  it("includes the checklist state (obligation + requirementLevel) in the sections", () => {
    const sections = buildTravelExportSections(DTO);
    const text = sections.flatMap((s) => s.lines).join("\n");
    expect(text).toContain("Documentación a presentar");
    expect(text).toContain("A presentar");
    expect(text).toMatch(/Atención|blocker|Bloqueante|Informativo/);
  });

  it("includes the semaforo summary", () => {
    const sections = buildTravelExportSections(DTO);
    const text = sections.flatMap((s) => s.lines).join("\n");
    expect(text).toContain("Revisar pendientes");
  });
});

describe("generateTravelExportPdf — smoke render", () => {
  it("renders ONE multi-section PDF buffer (R5.1)", async () => {
    const bytes = await generateTravelExportPdf(DTO);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Integration — generateTravelExport (Storage mocked, DB real) — S14
// ---------------------------------------------------------------------------

const TRAVEL_PET_TOKEN = "DIM-TRAV-EXP01";
const TRAVEL_PET_TOKEN_EMPTY = "DIM-TRAV-EXP02";
const MOCK_OWNER_ID = "eeeeeeee-1111-0000-0000-000000000021";
const MOCK_SIGNED_URL = "https://storage.example.com/travel-exports/test.pdf?token=mock";

let travelPetId: string;

const mockCreateClient = vi.mocked(supabaseServer.createClient);
const mockRequireUserOrRedirect = vi.mocked(authGuards.requireUserOrRedirect);

function buildSupabaseMock() {
  const mock = {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: MOCK_OWNER_ID, email: "travel-owner@dim-test.local" } },
      }),
    },
    storage: {
      from: vi.fn().mockReturnValue({
        upload: vi.fn().mockResolvedValue({ data: { path: "x" }, error: null }),
        createSignedUrl: vi
          .fn()
          .mockResolvedValue({ data: { signedUrl: MOCK_SIGNED_URL }, error: null }),
      }),
    },
  };
  adminHolder.current = mock;
  return mock;
}

async function purgeFixtures() {
  await withMutationOverride(async (tx) => {
    for (const token of [TRAVEL_PET_TOKEN, TRAVEL_PET_TOKEN_EMPTY]) {
      await tx.execute(
        sql`DELETE FROM ownerships WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${token})`,
      );
      await tx.execute(sql`DELETE FROM pets WHERE public_token = ${token}`);
    }
  });
}

beforeAll(async () => {
  await purgeFixtures();
  await db
    .insert(profiles)
    .values({
      id: MOCK_OWNER_ID,
      displayName: "Travel Owner Test",
      role: "owner",
      accountType: "personal",
    })
    .onConflictDoNothing({ target: profiles.id });

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: TRAVEL_PET_TOKEN,
      name: "Rita",
      species: "dog",
      sex: "female",
      jurisdictionCountry: "AR",
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Palermo",
    })
    .returning();
  travelPetId = pet.id;
  await db.insert(ownerships).values({
    petId: travelPetId,
    ownerUserId: MOCK_OWNER_ID,
    role: "owner",
    startedAt: new Date(),
  });

  // Two future trips on two corridors → 2 applicable corridor sections (S14).
  const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  await db.insert(petEvents).values(
    (["chile", "uruguay"] as const).map((corridorId) => ({
      petId: travelPetId,
      eventType: "movement_recorded",
      occurredAt: new Date(),
      recordedAt: new Date(),
      recordedByUserId: MOCK_OWNER_ID,
      authorRole: "owner" as const,
      authorOrganizationId: null,
      authorVerified: false,
      payload: {
        payload_version: 1,
        sub_kind: "transport_recorded",
        corridor_id: corridorId,
        direction: "outbound_from_ar",
        travel_date: future,
        mode: "air",
        purpose: null,
      },
      notes: null,
    })),
  );

  // Second pet with zero movement events (no export context).
  await db
    .insert(pets)
    .values({
      publicToken: TRAVEL_PET_TOKEN_EMPTY,
      name: "SinViaje",
      species: "dog",
      sex: "male",
    })
    .returning()
    .then(async ([p]) => {
      await db.insert(ownerships).values({
        petId: p.id,
        ownerUserId: MOCK_OWNER_ID,
        role: "owner",
        startedAt: new Date(),
      });
    });
});

afterAll(async () => {
  await purgeFixtures();
});

describe("generateTravelExport — S14 happy path", () => {
  it("returns exactly ONE signed URL and inserts one travel_export_generated audit row", async () => {
    const supabaseMock = buildSupabaseMock();
    mockCreateClient.mockResolvedValue(supabaseMock as never);
    mockRequireUserOrRedirect.mockResolvedValue({
      supabase: supabaseMock,
      user: { id: MOCK_OWNER_ID },
    } as never);

    // audit_log is append-only (DB trigger blocks DELETE) — scope hermetically
    // with a before/after count instead of an absolute count.
    const countTravelRows = async () => {
      const rows = await db
        .select({ payload: auditLog.payload, action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.actorUserId, MOCK_OWNER_ID));
      return rows.filter((r) => r.action === "travel_export_generated");
    };
    const before = await countTravelRows();

    const result = await generateTravelExport(TRAVEL_PET_TOKEN);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signedUrl).toBe(MOCK_SIGNED_URL);

    const after = await countTravelRows();
    expect(after.length).toBe(before.length + 1); // exactly ONE new row (S14)

    const payload = after[after.length - 1].payload as Record<string, unknown>;
    expect(payload.petPublicToken).toBe(TRAVEL_PET_TOKEN);
    expect(payload.schemaVersion).toBe(TRAVEL_EXPORT_SCHEMA_VERSION);
    expect(payload.corridorIds).toEqual(expect.arrayContaining(["chile", "uruguay"]));
  });
});

describe("generateTravelExport — guards", () => {
  it("returns not_found when the user does not own the pet", async () => {
    const OTHER_USER = "eeeeeeee-1111-0000-0000-000000000022";
    await db
      .insert(profiles)
      .values({ id: OTHER_USER, displayName: "Other Travel User", role: "owner" })
      .onConflictDoNothing({ target: profiles.id });

    const supabaseMock = buildSupabaseMock();
    mockCreateClient.mockResolvedValue(supabaseMock as never);
    mockRequireUserOrRedirect.mockResolvedValue({
      supabase: supabaseMock,
      user: { id: OTHER_USER },
    } as never);

    const result = await generateTravelExport(TRAVEL_PET_TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("not_found");
  });

  it("returns no_movement_context when the pet has zero movement_recorded events", async () => {
    const supabaseMock = buildSupabaseMock();
    mockCreateClient.mockResolvedValue(supabaseMock as never);
    mockRequireUserOrRedirect.mockResolvedValue({
      supabase: supabaseMock,
      user: { id: MOCK_OWNER_ID },
    } as never);

    const result = await generateTravelExport(TRAVEL_PET_TOKEN_EMPTY);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("no_movement_context");
  });
});
