// Tests for the travel doc bundle export (movilidad-jurisdiccional Fase 1,
// Capability 5 — R5.1-R5.4, S14; rebuilt on loadTravelView in viajes-fase-2
// Phase 7).
//
// Unit: schema version, storage path convention, section builder (per-corridor
// disclaimer + version/effectiveFrom — R5.4 applies the R3.5 disclaimer to the
// exported artifact exactly as on-screen), PDF smoke render.
// Phase 7: the DTO is the travel view's own reading (same semáforo, same
// obligations, the screen's label); a stale rule prints "Verificá", never a
// clean pass; the airline block and per-source dates; no forbidden promise.
// Integration: generateTravelExportAction against local DB (Storage mocked,
// ppp-caba-export pattern) — ONE PDF signed URL + ONE travel_export_generated
// audit_log row carrying schemaVersion (S14) and neither the airline nor the
// travel date.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { auditLog, db, ownerships, petEvents, pets, profiles } from "@/db";
import {
  TRAVEL_EXPORT_SCHEMA_VERSION,
  buildTravelExportPath,
  buildTravelExportSections,
  generateTravelExportPdf,
} from "@/lib/analytics/travel-exports";
import {
  TRAVEL_AIRLINE_NOTICE,
  TRAVEL_FORBIDDEN_COPY,
  TRAVEL_SEMAFORO_LABELS,
} from "@/lib/domain/travel-copy";
import * as authGuards from "@/lib/infra/auth-guards";
import { TRAVEL_DISCLAIMER } from "@/lib/reference/cross-border-corridors";
import * as supabaseServer from "@/lib/supabase/server";
import {
  buildTravelExportDto,
  generateTravelExport,
} from "@/src/modules/pets/application/travel-export/generate-travel-export";
import {
  buildTravelView,
  loadTravelView,
} from "@/src/modules/pets/application/travel/load-travel-view";
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
  tripSummary: "Chile, 12/11/2026",
  airline: null,
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
      id: "required_documents",
      key: "required_documents" as const,
      group: "destino" as const,
      sources: [],
      freshnessNotice: null,
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
// Unit — the DTO is the travel view's reading (viajes-fase-2, Phase 7)
// ---------------------------------------------------------------------------

const VIEW_PET = {
  id: "00000000-0000-4000-8000-0000000000e7",
  publicToken: "DIM-TRAV-VIEW",
  name: "Rita",
  species: "dog",
  breed: "Dogo Argentino",
  dateOfBirth: "2022-01-10",
  birthDateIsEstimated: false,
  jurisdictionCountry: "AR",
  jurisdictionProvince: "CABA",
  jurisdictionLocality: "Palermo",
};

/** One trip to Chile with Iberia in the hold, 20 days after `now`. */
function viewAt(now: Date, documentsConfirmed?: string[]) {
  const travelDate = new Date(now.getTime() + 20 * 86_400_000).toISOString().slice(0, 10);
  return buildTravelView({
    pet: VIEW_PET,
    events: [
      {
        id: "00000000-0000-4000-8000-0000000000f1",
        eventType: "movement_recorded",
        occurredAt: now,
        payload: {
          payload_version: 1,
          sub_kind: "transport_recorded",
          corridor_id: "chile",
          direction: "outbound_from_ar",
          travel_date: travelDate,
          mode: "air",
          airline_id: "iberia",
          intended_modality: "hold",
          // As overlayAmendments folds a "Lo tengo" correction in.
          ...(documentsConfirmed ? { documents_confirmed: documentsConfirmed } : {}),
        },
      },
    ],
    tripId: null,
    now,
  });
}

function dtoAt(now: Date, documentsConfirmed?: string[]) {
  const view = viewAt(now, documentsConfirmed);
  const dto = buildTravelExportDto({
    pet: VIEW_PET,
    view,
    ownerDisplayName: "María López",
    generatedAt: now,
  });
  if (!dto) throw new Error("fixture: no trip in the view");
  return {
    view,
    dto,
    text: buildTravelExportSections(dto)
      .flatMap((s) => [s.heading, ...s.lines])
      .join("\n"),
  };
}

describe("travel export — the papers, with what the owner ticked (PO 2026-10-01)", () => {
  it("prints each document with its confirmed state, as the screen shows it", () => {
    const now = new Date();
    const unticked = dtoAt(now);
    const papers =
      unticked.dto.obligations.find((o) => o.key === "required_documents")?.documents ?? [];
    expect(papers.length).toBeGreaterThan(1);
    const [first, ...rest] = papers.map((d) => d.label);
    for (const label of [first, ...rest]) {
      expect(unticked.text).toContain(`[ ] ${label}: sin confirmar`);
    }

    const { text } = dtoAt(now, [first ?? ""]);
    expect(text).toContain(`[x] ${first}: lo tenés, según indicaste`);
    for (const label of rest) expect(text).toContain(`[ ] ${label}: sin confirmar`);
    expect(text).not.toMatch(TRAVEL_FORBIDDEN_COPY);
  });
});

describe("buildTravelExportDto — the screen's reading, not a second computation", () => {
  it("carries the view's semáforo, obligations and corridors by reference", () => {
    const { view, dto } = dtoAt(new Date());
    expect(dto.semaforo).toBe(view.compliance?.semaforo);
    expect(dto.obligations).toBe(view.compliance?.obligations);
    expect(dto.corridors).toBe(view.compliance?.corridorsShown);
  });

  it("says the semáforo in the screen's words and never promises", () => {
    const { dto, text } = dtoAt(new Date());
    expect(text).toContain(`Semáforo: ${TRAVEL_SEMAFORO_LABELS[dto.semaforo]}`);
    expect(text).not.toMatch(TRAVEL_FORBIDDEN_COPY);
    // The Fase 1 table's green is gone for good, whatever the colour.
    for (const semaforo of ["rojo", "amarillo", "verde", "sin_datos"] as const) {
      const all = buildTravelExportSections({ ...dto, semaforo })
        .flatMap((s) => s.lines)
        .join("\n");
      expect(all).not.toMatch(TRAVEL_FORBIDDEN_COPY);
    }
  });

  it("prints the airline block and every source with the date it was checked", () => {
    const { dto, text } = dtoAt(new Date());
    expect(dto.airline).toMatchObject({ name: "Iberia", modality: "bodega" });
    expect(text).toContain(`${TRAVEL_AIRLINE_NOTICE}: Iberia`);
    expect(text).toContain("Modalidad elegida: bodega");
    const sourced = dto.obligations.flatMap((o) => o.sources);
    expect(sourced.length).toBeGreaterThan(0);
    for (const s of sourced) expect(text).toContain(`Fuente: ${s.label} (${s.sourceUrl})`);
  });

  it("names the trip it read", () => {
    const { dto, text } = dtoAt(new Date());
    expect(dto.tripSummary).toMatch(/^Chile, \d{2}\/\d{2}\/\d{4} · Iberia, en bodega$/);
    expect(text).toContain(`Viaje: ${dto.tripSummary}`);
  });

  it("is null when there is no trip to read", () => {
    const view = buildTravelView({ pet: VIEW_PET, events: [], tripId: null, now: new Date() });
    expect(
      buildTravelExportDto({ pet: VIEW_PET, view, ownerDisplayName: "x", generatedAt: new Date() }),
    ).toBeNull();
  });
});

describe("travel export — a stale rule prints 'Verificá', never a clean pass (spec 'Stale export')", () => {
  // Years past every reviewBy in the registries: every corridor and airline
  // rule is expired at this instant.
  const STALE_NOW = new Date("2031-03-01T12:00:00Z");

  it("shows the same 'Verificá' state the screen shows, on every degraded row", () => {
    const { view, dto, text } = dtoAt(STALE_NOW);
    const degraded = dto.obligations.filter((o) => o.freshnessNotice !== null);
    // Rows that read clean today are degraded once their rules expire.
    const degradedToday = dtoAt(new Date()).dto.obligations.filter(
      (o) => o.freshnessNotice !== null,
    );
    expect(degraded.length).toBeGreaterThan(degradedToday.length);
    expect(
      degraded.some((o) => /^Verificá — dato sin revisar desde/.test(o.freshnessNotice ?? "")),
    ).toBe(true);
    for (const o of degraded) {
      expect(o.freshnessNotice).toMatch(/^Verificá — /);
      expect(text).toContain(o.freshnessNotice as string);
    }
    // Nothing stale reads green, on the screen or on paper.
    expect(view.compliance?.semaforo).not.toBe("verde");
    expect(text).not.toContain(TRAVEL_SEMAFORO_LABELS.verde);
  });

  it("renders to a real PDF — every word the engine writes fits the PDF font", async () => {
    for (const now of [new Date(), STALE_NOW]) {
      const bytes = await generateTravelExportPdf(dtoAt(now).dto);
      expect(bytes.length).toBeGreaterThan(1000);
    }
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
    // Design D7 + PO 2026-10-01: admin readers of the audit log are not
    // titulars. Nothing that says when the household is away, how, or WHERE —
    // the corridor names the destination, so it left the payload too.
    expect(Object.keys(payload).sort()).toEqual(
      ["petId", "petPublicToken", "schemaVersion", "semaforo"].sort(),
    );
    expect(JSON.stringify(payload)).not.toMatch(
      /airline|travel_?date|corridor|chile|uruguay|brasil|espana|usa/i,
    );
  });

  it("prints the trip the page is showing — and its semáforo is the page's", async () => {
    const supabaseMock = buildSupabaseMock();
    mockRequireUserOrRedirect.mockResolvedValue({
      supabase: supabaseMock,
      user: { id: MOCK_OWNER_ID },
    } as never);

    const rows = await db
      .select({ id: petEvents.id, payload: petEvents.payload })
      .from(petEvents)
      .where(eq(petEvents.petId, travelPetId));
    const uruguay = rows.find(
      (r) => (r.payload as Record<string, unknown>).corridor_id === "uruguay",
    );
    if (!uruguay) throw new Error("fixture: no uruguay trip");

    const auditRows = () =>
      db
        .select({ id: auditLog.id, payload: auditLog.payload })
        .from(auditLog)
        .where(eq(auditLog.actorUserId, MOCK_OWNER_ID));
    const before = new Set((await auditRows()).map((r) => r.id));
    const result = await generateTravelExport(TRAVEL_PET_TOKEN, uruguay.id);
    expect(result.ok).toBe(true);

    const added = (await auditRows()).filter((r) => !before.has(r.id));
    expect(added).toHaveLength(1);
    const payload = added[0].payload as Record<string, unknown>;
    // The audit no longer names the corridor (PO 2026-10-01), so WHICH trip was
    // printed is read off the stored file's path, which the titular's own
    // bucket keys by corridor.
    expect(payload).not.toHaveProperty("corridorIds");
    const bucket = supabaseMock.storage.from.mock.results[0]?.value as {
      upload: { mock: { calls: unknown[][] } };
    };
    expect(String(bucket.upload.mock.calls[0]?.[0])).toContain("uruguay");

    const [pet] = await db.select().from(pets).where(eq(pets.id, travelPetId));
    const screen = await loadTravelView({
      pet,
      viewer: { accessPath: "owner", holderRole: "owner" },
      tripId: uruguay.id,
    });
    if (!screen.ok) throw new Error("fixture: the titular was refused");
    expect(payload.semaforo).toBe(screen.view.compliance?.semaforo);
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

  it("returns not_found to a caretaker of the pet — the trip is the titular's (D8)", async () => {
    const CARETAKER_USER = "eeeeeeee-1111-0000-0000-000000000023";
    await db
      .insert(profiles)
      .values({ id: CARETAKER_USER, displayName: "Travel Caretaker", role: "owner" })
      .onConflictDoNothing({ target: profiles.id });
    await db.insert(ownerships).values({
      petId: travelPetId,
      ownerUserId: CARETAKER_USER,
      role: "caretaker",
      startedAt: new Date(),
    });

    const supabaseMock = buildSupabaseMock();
    mockCreateClient.mockResolvedValue(supabaseMock as never);
    mockRequireUserOrRedirect.mockResolvedValue({
      supabase: supabaseMock,
      user: { id: CARETAKER_USER },
    } as never);

    const refused = await generateTravelExport(TRAVEL_PET_TOKEN);
    expect(refused).toEqual({ ok: false, error: "not_found" });

    // The titular of the same pet still gets the PDF.
    mockRequireUserOrRedirect.mockResolvedValue({
      supabase: supabaseMock,
      user: { id: MOCK_OWNER_ID },
    } as never);
    const allowed = await generateTravelExport(TRAVEL_PET_TOKEN);
    expect(allowed.ok).toBe(true);
  });

  it("returns not_found to a USER holding shelter_custody — allow-list, not 'not a caretaker'", async () => {
    // A neighbour keeping a found animal. The role is legal on the person path
    // (only the ORG-held shelter_custody is capped per pet) and is not a titular.
    const SHELTER_HOLDER = "eeeeeeee-1111-0000-0000-000000000024";
    await db
      .insert(profiles)
      .values({ id: SHELTER_HOLDER, displayName: "Travel Shelter Holder", role: "owner" })
      .onConflictDoNothing({ target: profiles.id });
    await db.insert(ownerships).values({
      petId: travelPetId,
      ownerUserId: SHELTER_HOLDER,
      role: "shelter_custody",
      startedAt: new Date(),
    });

    const supabaseMock = buildSupabaseMock();
    mockCreateClient.mockResolvedValue(supabaseMock as never);
    mockRequireUserOrRedirect.mockResolvedValue({
      supabase: supabaseMock,
      user: { id: SHELTER_HOLDER },
    } as never);

    const refused = await generateTravelExport(TRAVEL_PET_TOKEN);
    expect(refused).toEqual({ ok: false, error: "not_found" });
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
