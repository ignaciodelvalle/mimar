// Tests for Welfare MPF CABA export (Chunk F, F1).
//
// Unit tests: welfareReportToMpfDto mapper (pure, no DB).
// Integration tests: generateMpfExportAction + audit_log assertion (against local DB).
//
// Integration tests mock Supabase Storage upload and signed URL since the
// `welfare-exports` bucket is owner-created ops and not auto-provisioned in CI.
// The audit_log insert is real (hit the DB).

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { WelfareReport } from "@/db";
import { db, pets, profiles, welfareReports } from "@/db";
import {
  COORDINATE_DECIMALS,
  MPF_EXPORT_SCHEMA_VERSION,
  formatCoordinate,
  knowledgeGapLabel,
  welfareReportToMpfDto,
} from "@/lib/analytics/welfare-exports";
import * as authGuards from "@/lib/infra/auth-guards";
import * as supabaseServer from "@/lib/supabase/server";
import { generateMpfExportAction } from "@/src/modules/welfare/actions";
import { withMutationOverride } from "./_helpers/db-overrides";

// Hoist vi.mock calls so they apply before any imports are resolved.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/infra/auth-guards", () => ({
  requireAdminOrGovtOrRedirect: vi.fn(),
  requireUserOrRedirect: vi.fn(),
}));

// Service-role storage client (migration 0172). buildSupabaseMock() below points
// this holder at the same mock object it returns, so a test that installs the
// storage mock installs it for the real code path too.
const adminHolder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => adminHolder.current,
}));

// ---------------------------------------------------------------------------
// Unit tests — welfareReportToMpfDto (pure function, no DB)
// ---------------------------------------------------------------------------

function makeReport(overrides: Partial<WelfareReport> = {}): WelfareReport {
  return {
    id: "aaaaaaaa-0000-0000-0000-000000000001",
    referenceCode: "DEN-TEST-0001",
    reporterUserId: null,
    reporterOrganizationId: null,
    reporterContactEmail: null,
    reporterContactPhone: null,
    kind: "neglect",
    severity: "high",
    description: "Test description for welfare MPF unit tests.",
    subjectKind: "unowned_animal",
    subjectPetId: null,
    subjectDescription: "Perro callejero sin collar",
    locationAddress: "Av. Corrientes 1234",
    jurisdictionProvince: "CABA",
    jurisdictionLocality: "CABA",
    locationLat: "-34.6037",
    locationLng: "-58.3816",
    occurredAt: new Date("2026-05-15T10:00:00Z"),
    createdAt: new Date("2026-05-21T08:00:00Z"),
    status: "open",
    triagedAt: null,
    triagedByUserId: null,
    closedAt: null,
    resolutionNotes: null,
    flaggedAt: null,
    flagReasons: [],
    moderationResolvedAt: null,
    moderationResolvedByUserId: null,
    caseId: null,
    assignedToUserId: null,
    ...overrides,
  } as WelfareReport;
}

describe("welfareReportToMpfDto — anonymous redaction", () => {
  it("marks anonymous when both reporterUserId and reporterOrganizationId are null", () => {
    const report = makeReport({ reporterUserId: null, reporterOrganizationId: null });
    const dto = welfareReportToMpfDto(report, {
      reporterDisplayName: null,
      exportedByDisplayName: "Agente Fiscalía",
      subjectPet: null,
      attachments: [],
      exportGeneratedAt: new Date(),
    });
    expect(dto.reporterIsAnonymous).toBe(true);
    expect(dto.reporterDisplayName).toBeNull();
    expect(dto.reporterContactEmail).toBeNull();
    expect(dto.reporterContactPhone).toBeNull();
  });

  it("includes reporter info when reporterUserId is set", () => {
    const report = makeReport({
      reporterUserId: "bbbbbbbb-0000-0000-0000-000000000002",
      reporterContactEmail: "reporter@example.com",
    });
    const dto = welfareReportToMpfDto(report, {
      reporterDisplayName: "Juan Pérez",
      exportedByDisplayName: "Agente Fiscalía",
      subjectPet: null,
      attachments: [],
      exportGeneratedAt: new Date(),
    });
    expect(dto.reporterIsAnonymous).toBe(false);
    expect(dto.reporterDisplayName).toBe("Juan Pérez");
    expect(dto.reporterContactEmail).toBe("reporter@example.com");
  });
});

describe("welfareReportToMpfDto — subject pet", () => {
  it("returns subjectPet=null when no pet linked", () => {
    const report = makeReport({ subjectPetId: null, subjectDescription: null });
    const dto = welfareReportToMpfDto(report, {
      reporterDisplayName: null,
      exportedByDisplayName: "Agente",
      subjectPet: null,
      attachments: [],
      exportGeneratedAt: new Date(),
    });
    expect(dto.subjectPet).toBeNull();
    expect(dto.subjectDescription).toBeNull();
  });

  it("includes subject pet name and microchip when subjectPet is provided", () => {
    const report = makeReport({
      subjectPetId: "cccccccc-0000-0000-0000-000000000003",
      subjectKind: "registered_pet",
    });
    const dto = welfareReportToMpfDto(report, {
      reporterDisplayName: null,
      exportedByDisplayName: "Agente",
      subjectPet: { name: "Rex", microchipId: "999000000000099" },
      attachments: [],
      exportGeneratedAt: new Date(),
    });
    expect(dto.subjectPet?.name).toBe("Rex");
    expect(dto.subjectPet?.microchipId).toBe("999000000000099");
  });
});

describe("welfareReportToMpfDto — occurredAt", () => {
  it("returns 'no especificada' text when occurredAt is null", () => {
    const report = makeReport({ occurredAt: null });
    const dto = welfareReportToMpfDto(report, {
      reporterDisplayName: null,
      exportedByDisplayName: "Agente",
      subjectPet: null,
      attachments: [],
      exportGeneratedAt: new Date(),
    });
    expect(dto.occurredAtLabel).toContain("no especificada");
  });
});

describe("welfareReportToMpfDto — knowledge chronology (task #77 bitemporal)", () => {
  it("computes the knowledge gap between occurrence (valid time) and intake (transaction time)", () => {
    // occurred 2026-05-15 10:00Z, recorded 2026-05-21 08:00Z → ~6 days later.
    const report = makeReport({
      occurredAt: new Date("2026-05-15T10:00:00Z"),
      createdAt: new Date("2026-05-21T08:00:00Z"),
    });
    const dto = welfareReportToMpfDto(report, {
      reporterDisplayName: null,
      exportedByDisplayName: "Agente",
      subjectPet: null,
      attachments: [],
      exportGeneratedAt: new Date(),
    });
    expect(dto.knowledgeGapLabel).not.toBeNull();
    expect(dto.knowledgeGapLabel).toContain("6 días");
    expect(dto.knowledgeGapLabel).toContain("conocimiento");
  });

  it("returns a null gap when the denunciante declared no occurrence date", () => {
    const report = makeReport({ occurredAt: null });
    const dto = welfareReportToMpfDto(report, {
      reporterDisplayName: null,
      exportedByDisplayName: "Agente",
      subjectPet: null,
      attachments: [],
      exportGeneratedAt: new Date(),
    });
    expect(dto.knowledgeGapLabel).toBeNull();
  });

  it("uses the singular form for a one-day gap", () => {
    const report = makeReport({
      occurredAt: new Date("2026-05-20T09:00:00Z"),
      createdAt: new Date("2026-05-21T09:00:00Z"),
    });
    const dto = welfareReportToMpfDto(report, {
      reporterDisplayName: null,
      exportedByDisplayName: "Agente",
      subjectPet: null,
      attachments: [],
      exportGeneratedAt: new Date(),
    });
    expect(dto.knowledgeGapLabel).toContain("1 día después");
  });
});

// ---------------------------------------------------------------------------
// knowledgeGapLabel — the paragraph that must not hedge
//
// This block's stated purpose is "evaluar la diligencia y los plazos de
// actuación", and it used to hedge on its own headline number: `days <= 0`
// collapsed "the same day" and "before the declared date" into one sentence
// ending "(o antes de la fecha declarada por el denunciante)".
//
// It is a CODE defect, not a data one. Verified against the database on
// 2026-07-30: 2.837 welfare reports, 2.740 with occurrence EXACTLY equal to
// intake, and ZERO with occurrence after intake. The parenthetical was false
// for every row that has ever existed.
// ---------------------------------------------------------------------------

describe("knowledgeGapLabel — a same-day gap says same day, full stop", () => {
  const AT_21 = new Date("2026-06-20T00:00:00Z"); // 2026-06-19 21:00 in AR (UTC-3)

  it("states the same day without hedging when occurrence and intake are the same instant", () => {
    // The overwhelmingly common shape in the data: occurred_at = created_at.
    const label = knowledgeGapLabel(AT_21, AT_21);
    expect(label).toBe("La autoridad tomó conocimiento el mismo día del hecho denunciado.");
  });

  it("never offers 'o antes' as a possibility on a same-day gap", () => {
    // The exact ambiguity that ruined the diligence paragraph.
    expect(knowledgeGapLabel(AT_21, AT_21)).not.toContain("o antes");
  });

  it("counts the same Argentine calendar day as zero even across the UTC midnight boundary", () => {
    // 2026-06-19 21:00 AR is already 2026-06-20 in UTC. A UTC-based day
    // boundary would call this a one-day gap and contradict the two dates
    // printed above it, both of which are AR-pinned.
    const occurred = new Date("2026-06-20T00:00:00Z"); // 19 Jun 21:00 AR
    const intake = new Date("2026-06-20T02:00:00Z"); // 19 Jun 23:00 AR
    expect(knowledgeGapLabel(occurred, intake)).toContain("el mismo día");
  });

  it("uses the ARGENTINE calendar day, not the UTC one, when the two disagree", () => {
    // 19 Jun 17:00 AR and 19 Jun 22:00 AR — the same Argentine day, and the
    // same date printed in both fields above this sentence. In UTC they fall
    // on 19 and 20 June, so a UTC-based day boundary would announce a one-day
    // gap under two identical printed dates.
    const occurred = new Date("2026-06-19T20:00:00Z"); // 19 Jun 17:00 AR
    const intake = new Date("2026-06-20T01:00:00Z"); // 19 Jun 22:00 AR
    expect(knowledgeGapLabel(occurred, intake)).toContain("el mismo día");
    expect(knowledgeGapLabel(occurred, intake)).not.toContain("1 día después");
  });

  it("counts the NEXT Argentine calendar day as one day, however few hours elapsed", () => {
    // 6 hours apart, but two different printed dates. Elapsed-time rounding
    // called this "el mismo día" directly under 19 de junio / 20 de junio.
    const occurred = new Date("2026-06-20T00:00:00Z"); // 19 Jun 21:00 AR
    const intake = new Date("2026-06-20T06:00:00Z"); // 20 Jun 03:00 AR
    expect(knowledgeGapLabel(occurred, intake)).toContain("1 día después");
    expect(knowledgeGapLabel(occurred, intake)).not.toContain("mismo día");
  });

  it("counts plural days off the calendar dates, not elapsed hours", () => {
    const occurred = new Date("2026-06-20T00:00:00Z"); // 19 Jun 21:00 AR
    const intake = new Date("2026-06-22T02:00:00Z"); // 21 Jun 23:00 AR (~2.1 días)
    expect(knowledgeGapLabel(occurred, intake)).toContain("2 días después");
  });

  it("reports an intake recorded BEFORE the declared occurrence instead of hiding it", () => {
    // A distinct finding from a same-day intake: this record cannot be right,
    // and the fiscal is told there is something to verify.
    const occurred = new Date("2026-06-25T12:00:00Z");
    const intake = new Date("2026-06-19T12:00:00Z");
    const label = knowledgeGapLabel(occurred, intake);
    expect(label).toContain("registrada antes de la fecha del hecho");
    expect(label).not.toContain("mismo día");
  });

  it("says the inconsistency is reported, not corrected — the export never edits the record", () => {
    const label = knowledgeGapLabel(
      new Date("2026-06-25T12:00:00Z"),
      new Date("2026-06-19T12:00:00Z"),
    );
    expect(label).toContain("sin corregir");
  });

  it("returns null when no occurrence date was declared — there is no gap to compute", () => {
    expect(knowledgeGapLabel(null, new Date("2026-06-19T12:00:00Z"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GPS coordinate precision (2026-07-30)
//
// The denuncia printed "Lat: -34.6307660 · Lng: -58.3826932" — seven decimals,
// about one centimetre. The number comes from a browser geolocation fix or a
// pin the denunciante drops on a map; neither is accurate to a centimetre, and
// on an instrument filed with a fiscal every printed figure reads as evidence.
// ---------------------------------------------------------------------------

describe("formatCoordinate — precision the source can actually support", () => {
  it("prints five decimals — about a metre", () => {
    expect(formatCoordinate("-34.6307660")).toBe("-34.63077");
  });

  it("drops the centimetre digits that were only float noise", () => {
    expect(formatCoordinate("-58.3826932")).toBe("-58.38269");
  });

  it("rounds rather than truncates, so the point does not drift toward zero", () => {
    // Truncation would give -34.63076; the nearest 5-decimal point is ...77.
    expect(formatCoordinate("-34.6307660")).toBe("-34.63077");
    expect(formatCoordinate("58.1234567")).toBe("58.12346");
  });

  it("pads a short value so every coordinate on the page has the same shape", () => {
    expect(formatCoordinate("-34.6")).toBe("-34.60000");
  });

  it("keeps enough precision to distinguish adjacent properties on a street", () => {
    // ~11 m apart: two neighbouring front doors. Four decimals would collapse
    // these into one point and send an inspector to the wrong house.
    expect(formatCoordinate("-34.60370")).not.toBe(formatCoordinate("-34.60380"));
  });

  it("does not claim centimetre accuracy — two points 1 cm apart print the same", () => {
    expect(formatCoordinate("-34.6037000")).toBe(formatCoordinate("-34.6037001"));
  });

  it("prints the stored value verbatim when it does not parse — never 'NaN' in a legal document", () => {
    expect(formatCoordinate("no disponible")).toBe("no disponible");
  });

  it("never turns a blank coordinate into a plausible location", () => {
    // Number("") is 0 and 0 is finite, so the naive version printed "0.00000"
    // — a real point in the Gulf of Guinea, printed exactly like a measured
    // one. Found by this test, not by a mutant.
    expect(formatCoordinate("")).toBe("");
    expect(formatCoordinate("   ")).toBe("   ");
  });

  it("keeps the exact location: this is the official-use block, not the public view", () => {
    // Regression guard against a reflexive privacy blur. Ley 14.346 official
    // use is exactly why this block prints coordinates at all.
    expect(COORDINATE_DECIMALS).toBeGreaterThanOrEqual(5);
  });

  it("does not print more precision than the source can support", () => {
    expect(COORDINATE_DECIMALS).toBeLessThanOrEqual(5);
  });
});

describe("MPF_EXPORT_SCHEMA_VERSION", () => {
  it("is a non-empty string", () => {
    expect(typeof MPF_EXPORT_SCHEMA_VERSION).toBe("string");
    expect(MPF_EXPORT_SCHEMA_VERSION.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// MPF export format cascade (jurisdiction-compliance, 2026-07-22) — the
// mapper now stamps the resolved format + its provenance onto the DTO, and
// the fiscal unit label is jurisdiction-aware instead of a hardcoded
// "MPF CABA" string.
// ---------------------------------------------------------------------------

describe("welfareReportToMpfDto — MPF export format cascade", () => {
  it("defaults to the national format + 'default' source when no resolution is passed", () => {
    const report = makeReport({ jurisdictionProvince: "Chaco" });
    const dto = welfareReportToMpfDto(report, {
      reporterDisplayName: null,
      exportedByDisplayName: "Agente",
      subjectPet: null,
      attachments: [],
      exportGeneratedAt: new Date(),
    });
    expect(dto.mpfFormatLabel).toContain("Estándar nacional");
    expect(dto.mpfFormatProvenanceLabel).toBe("Default nacional");
  });

  it("reflects a resolved format + its cascade source (e.g. province override)", () => {
    const report = makeReport({ jurisdictionProvince: "Chaco" });
    const dto = welfareReportToMpfDto(report, {
      reporterDisplayName: null,
      exportedByDisplayName: "Agente",
      subjectPet: null,
      attachments: [],
      exportGeneratedAt: new Date(),
      mpfFormat: "estandar_nacional",
      mpfFormatSource: "province",
    });
    expect(dto.mpfFormatProvenanceLabel).toBe("Override provincia");
  });

  it("builds a jurisdiction-aware fiscal unit label — no hardcoded 'MPF CABA' regardless of province", () => {
    const chacoReport = makeReport({ jurisdictionProvince: "Chaco" });
    const dto = welfareReportToMpfDto(chacoReport, {
      reporterDisplayName: null,
      exportedByDisplayName: "Agente",
      subjectPet: null,
      attachments: [],
      exportGeneratedAt: new Date(),
    });
    expect(dto.fiscalUnitLabel).toContain("Chaco");
    expect(dto.fiscalUnitLabel).not.toContain("CABA");
  });

  it("falls back to a generic fiscal unit label when jurisdiction is unknown", () => {
    const report = makeReport({ jurisdictionProvince: null });
    const dto = welfareReportToMpfDto(report, {
      reporterDisplayName: null,
      exportedByDisplayName: "Agente",
      subjectPet: null,
      attachments: [],
      exportGeneratedAt: new Date(),
    });
    expect(dto.fiscalUnitLabel).toContain("a confirmar");
  });
});

// ---------------------------------------------------------------------------
// Integration tests — generateMpfExportAction (with Storage mocked)
// ---------------------------------------------------------------------------
//
// Mocking strategy: mock the storage methods so tests don't require a live
// `welfare-exports` bucket. The DB insert (audit_log) is real.
// Full Storage integration is marked TODO(E6-followup) per govt-exports.test.ts convention.
//
// Storage runs on the SERVICE-ROLE client since migration 0172 (the bucket has
// no authenticated policy to read through), so the storage mock is installed on
// @/lib/supabase/admin, not on the cookie-bound server client.

const WELFARE_REPORT_REF = "DEN-MPF-TEST01";
const WELFARE_PET_TOKEN = "DIM-MPF-PA01";
const MOCK_USER_ID = "dddddddd-0000-0000-0000-000000000004";
const MOCK_SIGNED_URL = "https://storage.example.com/welfare-exports/test.pdf?token=mock";

let welfareReportId: string;
let petId: string;
const govtUserId = MOCK_USER_ID;

// Typed mock accessors (works with ESM mocks via vi.mocked).
const mockCreateClient = vi.mocked(supabaseServer.createClient);
const mockRequireAdminOrGovt = vi.mocked(authGuards.requireAdminOrGovtOrRedirect);

function buildSupabaseMock(uploadError: null | string = null) {
  const mock = {
    auth: {
      getUser: vi
        .fn()
        .mockResolvedValue({ data: { user: { id: MOCK_USER_ID, email: "govt@test.local" } } }),
    },
    storage: {
      from: vi.fn().mockReturnValue({
        upload: vi.fn().mockResolvedValue({
          data: uploadError ? null : { path: "welfare-exports/test.pdf" },
          error: uploadError ? { message: uploadError } : null,
        }),
        createSignedUrl: vi.fn().mockResolvedValue({
          data: { signedUrl: MOCK_SIGNED_URL },
          error: null,
        }),
      }),
    },
  };
  // The export helpers sign and upload as service role — same mock, both doors.
  adminHolder.current = mock;
  return mock;
}

async function purgeFixtures() {
  // Note: audit_log is append-only (DB trigger blocks DELETE) — do NOT attempt
  // to delete audit_log rows here. Tests scope queries by actorUserId + action.
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM welfare_reports WHERE reference_code = ${WELFARE_REPORT_REF}`);
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${WELFARE_PET_TOKEN}`);
  });
}

describe("generateMpfExportAction — mocked storage", () => {
  beforeAll(async () => {
    await purgeFixtures();

    await db
      .insert(profiles)
      .values({
        id: MOCK_USER_ID,
        displayName: "MPF Test Govt",
        role: "govt",
        accountType: "institutional",
      })
      .onConflictDoNothing({ target: profiles.id });

    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: WELFARE_PET_TOKEN,
        name: "WelfarePetMPF",
        species: "dog",
        sex: "unknown",
        potentiallyDangerousBreed: false,
      })
      .returning();
    petId = pet.id;

    const [report] = await db
      .insert(welfareReports)
      .values({
        referenceCode: WELFARE_REPORT_REF,
        kind: "neglect",
        severity: "medium",
        description: "Integration test welfare report for MPF export (at least 20 chars here).",
        subjectKind: "registered_pet",
        subjectPetId: petId,
        // A2: the triage gate now rejects status "open" server-side — this
        // success-path fixture represents an already-triaged report.
        status: "triaged",
        jurisdictionProvince: "CABA",
        jurisdictionLocality: "CABA",
      })
      .returning();
    welfareReportId = report.id;
  });

  afterAll(async () => {
    await purgeFixtures();
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM pets WHERE id = ${petId}`);
    });
  });

  it("returns signed URL and inserts audit_log when storage succeeds", async () => {
    const supabaseMock = buildSupabaseMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(supabaseMock as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireAdminOrGovt.mockResolvedValue({
      profile: { id: govtUserId, role: "govt" },
      jurisdictions: [{ province: "CABA", locality: "CABA" }],
      user: { id: govtUserId },
      supabase: supabaseMock,
    } as any);

    const result = await generateMpfExportAction(welfareReportId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signedUrl).toBe(MOCK_SIGNED_URL);

    // Verify audit_log row scoped to this welfareReportId.
    const [logRow] = (await db.execute(
      sql`SELECT action, payload FROM audit_log
          WHERE actor_user_id = ${govtUserId}
            AND action = 'welfare_mpf_export_generated'
            AND payload->>'welfareReportId' = ${welfareReportId}
          ORDER BY performed_at DESC
          LIMIT 1`,
    )) as Array<{ action: string; payload: Record<string, unknown> }>;

    expect(logRow).toBeDefined();
    expect(logRow.action).toBe("welfare_mpf_export_generated");
    expect(logRow.payload.welfareReportId).toBe(welfareReportId);
    expect(logRow.payload.referenceCode).toBe(WELFARE_REPORT_REF);
    expect(logRow.payload.schemaVersion).toBe(MPF_EXPORT_SCHEMA_VERSION);
  });

  it("returns not_found for a govt out of scope", async () => {
    const supabaseMock = buildSupabaseMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(supabaseMock as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireAdminOrGovt.mockResolvedValue({
      profile: { id: govtUserId, role: "govt" },
      jurisdictions: [{ province: "Córdoba", locality: "Córdoba Capital" }],
      user: { id: govtUserId },
      supabase: supabaseMock,
    } as any);

    const result = await generateMpfExportAction(welfareReportId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("not_found");
  });

  it("A2: rejects an UNTRIAGED report on a direct call — no PDF, no audit row", async () => {
    // The client MpfExportGate only disables a button; this proves the server
    // refuses a formal Ley 14.346 document for a report nobody triaged yet.
    const [openReport] = await db
      .insert(welfareReports)
      .values({
        referenceCode: "WR-A2-UNTRIAGED",
        kind: "neglect",
        severity: "medium",
        description: "Integration test untriaged report for the A2 server-side gate.",
        subjectKind: "unowned_animal",
        subjectDescription: "Perro sin dueño",
        status: "open",
        jurisdictionProvince: "CABA",
        jurisdictionLocality: "CABA",
      })
      .returning();

    const supabaseMock = buildSupabaseMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(supabaseMock as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireAdminOrGovt.mockResolvedValue({
      profile: { id: govtUserId, role: "govt" },
      jurisdictions: [{ province: "CABA", locality: "CABA" }],
      user: { id: govtUserId },
      supabase: supabaseMock,
    } as any);

    const result = await generateMpfExportAction(openReport.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("untriaged");
    // Nothing was generated or recorded for the refused export.
    expect(supabaseMock.storage.from("welfare-exports").upload).not.toHaveBeenCalled();
    const auditRows = (await db.execute(
      sql`SELECT id FROM audit_log
          WHERE action = 'welfare_mpf_export_generated'
            AND payload->>'welfareReportId' = ${openReport.id}`,
    )) as Array<{ id: string }>;
    expect(auditRows).toHaveLength(0);

    await db.execute(sql`DELETE FROM welfare_reports WHERE id = ${openReport.id}`);
  });

  it("returns not_found for a non-existent welfareReportId", async () => {
    const supabaseMock = buildSupabaseMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(supabaseMock as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireAdminOrGovt.mockResolvedValue({
      profile: { id: govtUserId, role: "admin" },
      jurisdictions: [],
      user: { id: govtUserId },
      supabase: supabaseMock,
    } as any);

    const result = await generateMpfExportAction("00000000-dead-beef-0000-000000000000");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("not_found");
  });

  it("MPF export format cascade (jurisdiction-compliance, 2026-07-22): a non-CABA jurisdiction can now export — was blocked by the CABA-only gate", async () => {
    // Distinct fixture row in a province that used to be OUTSIDE
    // MPF_CONFIGURED_PROVINCES (removed) — the old gate blocked this before
    // any storage/PDF work happened. Now every jurisdiction resolves the
    // national default format (source: "default", zero override rows) and
    // exports successfully.
    const NON_CABA_REF = "DEN-MPF-TEST02";
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM welfare_reports WHERE reference_code = ${NON_CABA_REF}`);
    });
    const [nonCabaReport] = await db
      .insert(welfareReports)
      .values({
        referenceCode: NON_CABA_REF,
        kind: "neglect",
        severity: "medium",
        description: "Integration test welfare report outside the old MPF-configured jurisdiction.",
        subjectKind: "unowned_animal",
        subjectDescription: "Perro sin dueño",
        // A2: success-path fixture — already triaged (see the untriaged test).
        status: "triaged",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "Buenos Aires",
      })
      .returning();

    const supabaseMock = buildSupabaseMock();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockCreateClient.mockResolvedValue(supabaseMock as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRequireAdminOrGovt.mockResolvedValue({
      profile: { id: govtUserId, role: "admin" },
      jurisdictions: [],
      user: { id: govtUserId },
      supabase: supabaseMock,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const result = await generateMpfExportAction(nonCabaReport.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signedUrl).toBe(MOCK_SIGNED_URL);
    expect(supabaseMock.storage.from).toHaveBeenCalled();

    // Audit payload carries the resolved format + its provenance (traceability
    // twin of the "Formato del export" line printed on the PDF itself).
    const [logRow] = (await db.execute(
      sql`SELECT payload FROM audit_log
          WHERE action = 'welfare_mpf_export_generated'
            AND payload->>'welfareReportId' = ${nonCabaReport.id}
          ORDER BY performed_at DESC
          LIMIT 1`,
    )) as Array<{ payload: Record<string, unknown> }>;
    expect(logRow).toBeDefined();
    expect(logRow.payload.mpfExportFormat).toBe("estandar_nacional");
    expect(logRow.payload.mpfExportFormatSource).toBe("default");

    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM welfare_reports WHERE reference_code = ${NON_CABA_REF}`);
    });
  });

  it("audit_log payload storagePath has format {welfareReportId}/{timestamp}.pdf", async () => {
    // The idempotency window (24h) may cause the action to skip upload and reuse
    // the existing signed URL. Verify by inspecting the audit_log payload stored
    // by the first test in this suite.
    const [logRow] = (await db.execute(
      sql`SELECT payload FROM audit_log
          WHERE action = 'welfare_mpf_export_generated'
            AND payload->>'welfareReportId' = ${welfareReportId}
          ORDER BY performed_at DESC
          LIMIT 1`,
    )) as Array<{ payload: Record<string, unknown> }>;

    expect(logRow).toBeDefined();
    const storagePath: string = (logRow?.payload?.storagePath as string) ?? "";
    expect(storagePath).toMatch(new RegExp(`^${welfareReportId}/\\d+\\.pdf$`));
  });
});
