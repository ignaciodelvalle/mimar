// Unit tests for application/outbreak-investigation.ts (spec §H, §I)
// Strict TDD — tests written BEFORE implementation.
//
// Critical parity items:
//   - All 4 actions write audit_log INSIDE the tx with v1_noop:true (where applicable)
//   - All 4 actions enforce isInScope for govt actors — REJECT out-of-jurisdiction
//   - openInvestigation: dedupe by openedReason prefix 'manual [code]:'
//   - escalate: case must be 'open' (not already 'escalated'/'closed')
//   - closeInvestigation: outcome=resolved requires finalReport OR inline text
//   - addNote: notes≥5 chars
//   - escalate/close/addNote reason≥10 chars

import { describe, expect, it, vi } from "vitest";

import type { SurveillanceRepository } from "../infrastructure/surveillance-repository";
import {
  type OutbreakInvestigationDeps,
  addInvestigationNote,
  closeInvestigation,
  escalateInvestigation,
  isInScope,
  openOutbreakInvestigation,
  openerGrant,
} from "./outbreak-investigation";

type FakeRepo = Partial<Record<keyof SurveillanceRepository, ReturnType<typeof vi.fn>>>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCaseRow(
  overrides: Partial<{
    id: string;
    publicCode: string;
    status: string;
    caseKind: string;
    jurisdictionProvince: string | null;
    jurisdictionLocality: string | null;
    localityId: string | null;
    openedReason: string | null;
  }> = {},
) {
  return {
    id: "case-1",
    publicCode: "INV-2024-001",
    status: "open",
    caseKind: "outbreak_investigation",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    localityId: "loc-la-plata",
    openedReason: "manual [rabies]: Cluster detectado en zona norte",
    ...overrides,
  };
}

function makeRepo(overrides: FakeRepo = {}): SurveillanceRepository {
  return {
    findOpenInvestigationsForDisease: vi.fn().mockResolvedValue([]),
    findInvestigationByCode: vi.fn().mockResolvedValue(makeCaseRow()),
    // A legacy grant that recorded no row: the opener falls back to the name.
    findGrantLocalityId: vi.fn().mockResolvedValue(null),
    findFinalReport: vi.fn().mockResolvedValue(null),
    insertCaseEvent: vi.fn().mockResolvedValue({ id: "ce-1" }),
    insertOutbreakAuditLog: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SurveillanceRepository;
}

function makeDeps(repoOverrides: FakeRepo = {}): OutbreakInvestigationDeps {
  const repo = makeRepo(repoOverrides);
  return {
    repo,
    openCase: vi.fn().mockResolvedValue({ id: "case-1", publicCode: "INV-2024-001" }),
    resolveLocalityId: vi
      .fn()
      .mockImplementation(async (province: string | null, locality: string | null) =>
        province === "Buenos Aires" && locality === "La Plata" ? "loc-la-plata" : null,
      ),
    closeCase: vi.fn().mockResolvedValue(undefined),
    escalateCase: vi.fn().mockResolvedValue(undefined),
    transaction: vi
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb("fake-tx")),
    notifyOutbreakOpened: vi.fn().mockResolvedValue(undefined),
    revalidate: vi.fn(),
  };
}

const ADMIN_ACTOR = {
  profile: { id: "admin-1", role: "admin" as const },
  jurisdictions: [] as Array<{ province: string; locality: string }>,
};

const GOVT_IN_SCOPE = {
  profile: { id: "govt-1", role: "govt" as const },
  jurisdictions: [{ province: "Buenos Aires", locality: "La Plata" }],
};

const GOVT_OUT_SCOPE = {
  profile: { id: "govt-out-1", role: "govt" as const },
  jurisdictions: [{ province: "Córdoba", locality: "Río Cuarto" }],
};

// ---------------------------------------------------------------------------
// openOutbreakInvestigation (spec §H)
// ---------------------------------------------------------------------------

describe("openOutbreakInvestigation — happy path", () => {
  it("returns ok=true with publicCode for admin opening investigation", async () => {
    const deps = makeDeps();
    const result = await openOutbreakInvestigation(
      { diseaseCode: "rabies", reason: "Cluster detectado en zona norte", actor: ADMIN_ACTOR },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.publicCode).toBe("INV-2024-001");
  });

  it("returns ok=true for govt actor opening in their jurisdiction", async () => {
    const deps = makeDeps();
    const result = await openOutbreakInvestigation(
      { diseaseCode: "rabies", reason: "Casos confirmados en zona", actor: GOVT_IN_SCOPE },
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it("calls openCase with jurisdiction from govt actor's first assignment", async () => {
    const deps = makeDeps();
    await openOutbreakInvestigation(
      { diseaseCode: "rabies", reason: "Casos confirmados en zona", actor: GOVT_IN_SCOPE },
      deps,
    );
    expect(deps.openCase).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "outbreak_investigation",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "La Plata",
        // The catalogue row the grant pair names travels with it, or a
        // municipal holder on the id path would never see the case.
        localityId: "loc-la-plata",
      }),
      "fake-tx",
    );
    expect(deps.resolveLocalityId).toHaveBeenCalledWith("Buenos Aires", "La Plata");
  });

  it("calls openCase with null jurisdiction for admin (national scope)", async () => {
    const deps = makeDeps();
    await openOutbreakInvestigation(
      { diseaseCode: "rabies", reason: "Cluster detectado en zona norte", actor: ADMIN_ACTOR },
      deps,
    );
    expect(deps.openCase).toHaveBeenCalledWith(
      expect.objectContaining({
        jurisdictionProvince: null,
        jurisdictionLocality: null,
        localityId: null,
      }),
      "fake-tx",
    );
  });

  it("inserts case_opened caseEvent inside tx", async () => {
    const deps = makeDeps();
    await openOutbreakInvestigation(
      { diseaseCode: "rabies", reason: "Cluster detectado en zona norte", actor: ADMIN_ACTOR },
      deps,
    );
    expect(deps.repo.insertCaseEvent).toHaveBeenCalledWith(
      expect.objectContaining({ entryType: "case_opened" }),
      "fake-tx",
    );
  });

  it("inserts audit_log outbreak_investigation_opened with v1_noop:true inside tx", async () => {
    const deps = makeDeps();
    await openOutbreakInvestigation(
      { diseaseCode: "rabies", reason: "Cluster detectado en zona norte", actor: ADMIN_ACTOR },
      deps,
    );
    expect(deps.repo.insertOutbreakAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "outbreak_investigation_opened",
        payload: expect.objectContaining({ v1_noop: true }),
      }),
      "fake-tx",
    );
  });

  it("inserts signal_link event when linkedSignalEventId is provided", async () => {
    const deps = makeDeps();
    await openOutbreakInvestigation(
      {
        diseaseCode: "rabies",
        reason: "Cluster detectado en zona norte",
        linkedSignalEventId: "signal-99",
        actor: ADMIN_ACTOR,
      },
      deps,
    );
    const calls = (deps.repo.insertCaseEvent as ReturnType<typeof vi.fn>).mock.calls;
    const signalLinkCall = calls.find(
      (c: unknown[]) => (c[0] as { entryType: string }).entryType === "signal_link",
    );
    expect(signalLinkCall).toBeDefined();
  });

  it("calls notifyOutbreakOpened post-tx best-effort", async () => {
    const deps = makeDeps();
    await openOutbreakInvestigation(
      { diseaseCode: "rabies", reason: "Cluster detectado en zona norte", actor: ADMIN_ACTOR },
      deps,
    );
    expect(deps.notifyOutbreakOpened).toHaveBeenCalled();
  });
});

describe("openOutbreakInvestigation — validation errors", () => {
  it("returns error when diseaseCode is not in ENO catalog", async () => {
    const deps = makeDeps();
    const result = await openOutbreakInvestigation(
      { diseaseCode: "parvovirus", reason: "Cluster detectado en zona norte", actor: ADMIN_ACTOR },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/catálogo ENO/i);
  });

  it("returns error when reason is shorter than 10 chars", async () => {
    const deps = makeDeps();
    const result = await openOutbreakInvestigation(
      { diseaseCode: "rabies", reason: "short", actor: ADMIN_ACTOR },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/10 caracteres/i);
  });

  it("returns error when govt has no jurisdiction assignments", async () => {
    const deps = makeDeps();
    const actor = { profile: { id: "govt-nojur", role: "govt" as const }, jurisdictions: [] };
    const result = await openOutbreakInvestigation(
      { diseaseCode: "rabies", reason: "Cluster detectado en zona norte", actor },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/jurisdicciones/i);
  });

  it("returns error when duplicate open investigation exists for disease", async () => {
    const deps = makeDeps({
      findOpenInvestigationsForDisease: vi
        .fn()
        .mockResolvedValue([
          { id: "case-old", publicCode: "INV-2024-000", openedReason: "manual [rabies]: Anterior" },
        ]),
    });
    const result = await openOutbreakInvestigation(
      { diseaseCode: "rabies", reason: "Cluster detectado en zona norte", actor: ADMIN_ACTOR },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/ya existe/i);
  });
});

// ---------------------------------------------------------------------------
// addInvestigationNote (spec §I)
// ---------------------------------------------------------------------------

describe("addInvestigationNote — happy path", () => {
  it("returns ok=true for admin adding a note", async () => {
    const deps = makeDeps();
    const result = await addInvestigationNote(
      {
        casePublicCode: "INV-2024-001",
        entryType: "classification",
        notes: "Clasificado como brote activo",
        actor: ADMIN_ACTOR,
      },
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it("inserts caseEvent and audit_log inside tx (atomicity)", async () => {
    const deps = makeDeps();
    await addInvestigationNote(
      {
        casePublicCode: "INV-2024-001",
        entryType: "lab_result",
        notes: "Muestra positiva confirmada",
        actor: ADMIN_ACTOR,
      },
      deps,
    );
    expect(deps.repo.insertCaseEvent).toHaveBeenCalledWith(
      expect.objectContaining({ entryType: "lab_result" }),
      "fake-tx",
    );
    expect(deps.repo.insertOutbreakAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "outbreak_investigation_note_added" }),
      "fake-tx",
    );
  });
});

describe("addInvestigationNote — jurisdiction scope enforcement (CRITICAL)", () => {
  it("returns ok=true for govt actor in scope", async () => {
    const deps = makeDeps();
    const result = await addInvestigationNote(
      {
        casePublicCode: "INV-2024-001",
        entryType: "classification",
        notes: "Clasificado como brote activo",
        actor: GOVT_IN_SCOPE,
      },
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it("REJECTS govt actor out of scope (cross-org bypass guard)", async () => {
    const deps = makeDeps();
    const result = await addInvestigationNote(
      {
        casePublicCode: "INV-2024-001",
        entryType: "classification",
        notes: "Clasificado como brote activo",
        actor: GOVT_OUT_SCOPE,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/jurisdicción/i);
  });

  it("does NOT insert caseEvent when govt is out of scope", async () => {
    const deps = makeDeps();
    await addInvestigationNote(
      {
        casePublicCode: "INV-2024-001",
        entryType: "classification",
        notes: "Clasificado como brote activo",
        actor: GOVT_OUT_SCOPE,
      },
      deps,
    );
    expect(deps.repo.insertCaseEvent).not.toHaveBeenCalled();
  });
});

describe("addInvestigationNote — validation errors", () => {
  it("returns error when notes is shorter than 5 chars", async () => {
    const deps = makeDeps();
    const result = await addInvestigationNote(
      {
        casePublicCode: "INV-2024-001",
        entryType: "classification",
        notes: "Hi",
        actor: ADMIN_ACTOR,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/5 caracteres/i);
  });

  it("returns error when case not found", async () => {
    const deps = makeDeps({
      findInvestigationByCode: vi.fn().mockResolvedValue(null),
    });
    const result = await addInvestigationNote(
      {
        casePublicCode: "DOES-NOT-EXIST",
        entryType: "classification",
        notes: "Nota de prueba",
        actor: ADMIN_ACTOR,
      },
      deps,
    );
    expect(result.ok).toBe(false);
  });

  it("returns error when case is already closed", async () => {
    const deps = makeDeps({
      findInvestigationByCode: vi.fn().mockResolvedValue(makeCaseRow({ status: "closed" })),
    });
    const result = await addInvestigationNote(
      {
        casePublicCode: "INV-2024-001",
        entryType: "classification",
        notes: "Nota sobre caso cerrado",
        actor: ADMIN_ACTOR,
      },
      deps,
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// escalateInvestigation (spec §I)
// ---------------------------------------------------------------------------

describe("escalateInvestigation — happy path", () => {
  it("returns ok=true for admin escalating an open investigation", async () => {
    const deps = makeDeps();
    const result = await escalateInvestigation(
      { casePublicCode: "INV-2024-001", reason: "Nuevos casos confirmados", actor: ADMIN_ACTOR },
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it("calls escalateCase inside tx", async () => {
    const deps = makeDeps();
    await escalateInvestigation(
      { casePublicCode: "INV-2024-001", reason: "Nuevos casos confirmados", actor: ADMIN_ACTOR },
      deps,
    );
    expect(deps.escalateCase).toHaveBeenCalledWith("case-1", "fake-tx");
  });

  it("inserts case_escalated event and audit_log inside tx", async () => {
    const deps = makeDeps();
    await escalateInvestigation(
      { casePublicCode: "INV-2024-001", reason: "Nuevos casos confirmados", actor: ADMIN_ACTOR },
      deps,
    );
    expect(deps.repo.insertCaseEvent).toHaveBeenCalledWith(
      expect.objectContaining({ entryType: "case_escalated" }),
      "fake-tx",
    );
    expect(deps.repo.insertOutbreakAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "outbreak_investigation_escalated" }),
      "fake-tx",
    );
  });
});

describe("escalateInvestigation — jurisdiction scope enforcement (CRITICAL)", () => {
  it("REJECTS govt actor out of scope", async () => {
    const deps = makeDeps();
    const result = await escalateInvestigation(
      { casePublicCode: "INV-2024-001", reason: "Nuevos casos confirmados", actor: GOVT_OUT_SCOPE },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/jurisdicción/i);
  });

  it("does NOT call escalateCase when govt is out of scope", async () => {
    const deps = makeDeps();
    await escalateInvestigation(
      { casePublicCode: "INV-2024-001", reason: "Nuevos casos confirmados", actor: GOVT_OUT_SCOPE },
      deps,
    );
    expect(deps.escalateCase).not.toHaveBeenCalled();
  });
});

describe("escalateInvestigation — validation errors", () => {
  it("returns error when reason is shorter than 10 chars", async () => {
    const deps = makeDeps();
    const result = await escalateInvestigation(
      { casePublicCode: "INV-2024-001", reason: "short", actor: ADMIN_ACTOR },
      deps,
    );
    expect(result.ok).toBe(false);
  });

  it("returns error when case status is not 'open' (already escalated)", async () => {
    const deps = makeDeps({
      findInvestigationByCode: vi.fn().mockResolvedValue(makeCaseRow({ status: "escalated" })),
    });
    const result = await escalateInvestigation(
      { casePublicCode: "INV-2024-001", reason: "Nuevos casos confirmados", actor: ADMIN_ACTOR },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/estado abierto/i);
  });
});

// ---------------------------------------------------------------------------
// closeInvestigation (spec §I)
// ---------------------------------------------------------------------------

describe("closeInvestigation — happy path", () => {
  it("returns ok=true for dismissed outcome without finalReport", async () => {
    const deps = makeDeps();
    const result = await closeInvestigation(
      {
        casePublicCode: "INV-2024-001",
        outcome: "dismissed",
        reason: "No se confirmaron nuevos casos",
        actor: ADMIN_ACTOR,
      },
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it("returns ok=true for resolved with inline finalReportText", async () => {
    const deps = makeDeps();
    const result = await closeInvestigation(
      {
        casePublicCode: "INV-2024-001",
        outcome: "resolved",
        reason: "Brote contenido exitosamente",
        finalReportText: "Informe final del brote epidemiológico.",
        actor: ADMIN_ACTOR,
      },
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it("returns ok=true for resolved when final_report event already exists in DB", async () => {
    const deps = makeDeps({
      findFinalReport: vi.fn().mockResolvedValue({ id: "fr-1" }),
    });
    const result = await closeInvestigation(
      {
        casePublicCode: "INV-2024-001",
        outcome: "resolved",
        reason: "Brote contenido exitosamente",
        actor: ADMIN_ACTOR,
      },
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it("calls closeCase inside tx", async () => {
    const deps = makeDeps();
    await closeInvestigation(
      {
        casePublicCode: "INV-2024-001",
        outcome: "dismissed",
        reason: "No se confirmaron nuevos casos",
        actor: ADMIN_ACTOR,
      },
      deps,
    );
    expect(deps.closeCase).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: "case-1", reason: "cancelled" }),
      "fake-tx",
    );
  });

  it("calls closeCase with reason=resolved for resolved outcome", async () => {
    const deps = makeDeps({
      findFinalReport: vi.fn().mockResolvedValue({ id: "fr-1" }),
    });
    await closeInvestigation(
      {
        casePublicCode: "INV-2024-001",
        outcome: "resolved",
        reason: "Brote contenido exitosamente",
        actor: ADMIN_ACTOR,
      },
      deps,
    );
    expect(deps.closeCase).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "resolved" }),
      "fake-tx",
    );
  });

  it("inserts audit_log with correct action for resolved outcome", async () => {
    const deps = makeDeps({
      findFinalReport: vi.fn().mockResolvedValue({ id: "fr-1" }),
    });
    await closeInvestigation(
      {
        casePublicCode: "INV-2024-001",
        outcome: "resolved",
        reason: "Brote contenido exitosamente",
        actor: ADMIN_ACTOR,
      },
      deps,
    );
    expect(deps.repo.insertOutbreakAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "outbreak_investigation_closed_resolved",
        payload: expect.objectContaining({ v1_noop: true }),
      }),
      "fake-tx",
    );
  });

  it("inserts audit_log with correct action for dismissed outcome", async () => {
    const deps = makeDeps();
    await closeInvestigation(
      {
        casePublicCode: "INV-2024-001",
        outcome: "dismissed",
        reason: "No se confirmaron nuevos casos",
        actor: ADMIN_ACTOR,
      },
      deps,
    );
    expect(deps.repo.insertOutbreakAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "outbreak_investigation_closed_dismissed",
        payload: expect.objectContaining({ v1_noop: true }),
      }),
      "fake-tx",
    );
  });
});

describe("closeInvestigation — jurisdiction scope enforcement (CRITICAL)", () => {
  it("REJECTS govt actor out of scope", async () => {
    const deps = makeDeps();
    const result = await closeInvestigation(
      {
        casePublicCode: "INV-2024-001",
        outcome: "dismissed",
        reason: "No se confirmaron nuevos casos",
        actor: GOVT_OUT_SCOPE,
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/jurisdicción/i);
  });

  it("does NOT call closeCase when govt is out of scope", async () => {
    const deps = makeDeps();
    await closeInvestigation(
      {
        casePublicCode: "INV-2024-001",
        outcome: "dismissed",
        reason: "No se confirmaron nuevos casos",
        actor: GOVT_OUT_SCOPE,
      },
      deps,
    );
    expect(deps.closeCase).not.toHaveBeenCalled();
  });

  it("allows any govt actor on a national-scope case (no province)", async () => {
    const deps = makeDeps({
      findInvestigationByCode: vi
        .fn()
        .mockResolvedValue(makeCaseRow({ jurisdictionProvince: null, jurisdictionLocality: null })),
    });
    const result = await closeInvestigation(
      {
        casePublicCode: "INV-2024-001",
        outcome: "dismissed",
        reason: "No se confirmaron nuevos casos",
        actor: GOVT_OUT_SCOPE,
      },
      deps,
    );
    expect(result.ok).toBe(true);
  });
});

describe("closeInvestigation — validation errors", () => {
  it("returns error when case is already closed", async () => {
    const deps = makeDeps({
      findInvestigationByCode: vi.fn().mockResolvedValue(makeCaseRow({ status: "closed" })),
    });
    const result = await closeInvestigation(
      {
        casePublicCode: "INV-2024-001",
        outcome: "dismissed",
        reason: "No se confirmaron nuevos casos",
        actor: ADMIN_ACTOR,
      },
      deps,
    );
    expect(result.ok).toBe(false);
  });

  it("returns error when resolved outcome has no finalReport and no inline text", async () => {
    const deps = makeDeps({
      findFinalReport: vi.fn().mockResolvedValue(null),
    });
    const result = await closeInvestigation(
      {
        casePublicCode: "INV-2024-001",
        outcome: "resolved",
        reason: "Brote contenido exitosamente",
        actor: ADMIN_ACTOR,
        // No finalReportText provided
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/informe/i);
  });
});

// ---------------------------------------------------------------------------
// The id path — homonyms (security review F1 + code review M1, 2026-10)
// ---------------------------------------------------------------------------
//
// Córdoba has two localities named San Pedro in different departments. A
// unit grant compares by catalogue row; the name must never decide.

const SAN_PEDRO_A = "loc-san-pedro-a";
const SAN_PEDRO_B = "loc-san-pedro-b";

const GOVT_SAN_PEDRO_A_UNIT = {
  profile: { id: "govt-sp-a", role: "govt" as const },
  jurisdictions: [
    {
      province: "Córdoba",
      locality: "San Pedro",
      place: { path: "locality" as const, provinceCode: "AR-X", localityIds: [SAN_PEDRO_A] },
    },
  ],
};

const sanPedroCase = (localityId: string | null) =>
  makeCaseRow({
    jurisdictionProvince: "Córdoba",
    jurisdictionLocality: "San Pedro",
    localityId,
  });

describe("outbreak scope on the id path — homonyms", () => {
  it("REFUSES a San Pedro (A) unit holder acting on San Pedro (B) by its code", async () => {
    for (const run of [
      (deps: OutbreakInvestigationDeps) =>
        addInvestigationNote(
          {
            casePublicCode: "INV-SP-B",
            entryType: "classification",
            notes: "Nota de clasificación",
            actor: GOVT_SAN_PEDRO_A_UNIT,
          },
          deps,
        ),
      (deps: OutbreakInvestigationDeps) =>
        escalateInvestigation(
          {
            casePublicCode: "INV-SP-B",
            reason: "Escalamos por contagio",
            actor: GOVT_SAN_PEDRO_A_UNIT,
          },
          deps,
        ),
      (deps: OutbreakInvestigationDeps) =>
        closeInvestigation(
          {
            casePublicCode: "INV-SP-B",
            outcome: "dismissed",
            reason: "Descartado tras revisión",
            actor: GOVT_SAN_PEDRO_A_UNIT,
          },
          deps,
        ),
    ]) {
      const deps = makeDeps({
        findInvestigationByCode: vi.fn().mockResolvedValue(sanPedroCase(SAN_PEDRO_B)),
      });
      const result = await run(deps);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toMatch(/jurisdicci/i);
      expect(deps.transaction).not.toHaveBeenCalled();
    }
  });

  it("allows the same holder on their own San Pedro (A) case", async () => {
    const deps = makeDeps({
      findInvestigationByCode: vi.fn().mockResolvedValue(sanPedroCase(SAN_PEDRO_A)),
    });
    const result = await addInvestigationNote(
      {
        casePublicCode: "INV-SP-A",
        entryType: "classification",
        notes: "Nota de clasificación",
        actor: GOVT_SAN_PEDRO_A_UNIT,
      },
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it("an unresolved San Pedro case (no row) reaches the provincial unit, not a municipal one", () => {
    const provincial = [
      {
        province: "Córdoba",
        locality: "",
        place: { path: "province" as const, provinceCode: "AR-X" },
      },
    ];
    expect(isInScope(sanPedroCase(null), GOVT_SAN_PEDRO_A_UNIT.jurisdictions)).toBe(false);
    expect(isInScope(sanPedroCase(null), provincial)).toBe(true);
    expect(isInScope(sanPedroCase(SAN_PEDRO_B), provincial)).toBe(true);
  });

  it("a LEGACY grant keeps the name rule, unchanged (both San Pedros, by name)", () => {
    const legacy = [{ province: "Córdoba", locality: "San Pedro" }];
    expect(isInScope(sanPedroCase(SAN_PEDRO_A), legacy)).toBe(true);
    expect(isInScope(sanPedroCase(SAN_PEDRO_B), legacy)).toBe(true);
    expect(isInScope(sanPedroCase(null), legacy)).toBe(true);
    expect(
      isInScope(sanPedroCase(SAN_PEDRO_A), [{ province: "Córdoba", locality: "Jesús María" }]),
    ).toBe(false);
  });

  it("keeps spec §I: national case → any govt; province-wide case → any holder of the province", () => {
    const national = makeCaseRow({
      jurisdictionProvince: null,
      jurisdictionLocality: null,
      localityId: null,
    });
    const provinceWide = makeCaseRow({
      jurisdictionProvince: "Córdoba",
      jurisdictionLocality: null,
      localityId: null,
    });
    expect(isInScope(national, GOVT_SAN_PEDRO_A_UNIT.jurisdictions)).toBe(true);
    expect(isInScope(provinceWide, GOVT_SAN_PEDRO_A_UNIT.jurisdictions)).toBe(true);
    expect(isInScope(provinceWide, [{ province: "Salta", locality: "Cafayate" }])).toBe(false);
  });
});

describe("openOutbreakInvestigation — the opener's row, never a guessed homonym", () => {
  it("a unit holder on a homonym files under the row the grant recorded", async () => {
    const deps = makeDeps({ findGrantLocalityId: vi.fn().mockResolvedValue(SAN_PEDRO_A) });
    const result = await openOutbreakInvestigation(
      { diseaseCode: "rabies", reason: "Casos confirmados en zona", actor: GOVT_SAN_PEDRO_A_UNIT },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(deps.openCase).toHaveBeenCalledWith(
      expect.objectContaining({ jurisdictionLocality: "San Pedro", localityId: SAN_PEDRO_A }),
      "fake-tx",
    );
    // The name is never consulted when the grant knows its row.
    expect(deps.resolveLocalityId).not.toHaveBeenCalled();
    // And the opener keeps the case in scope on the id path.
    expect(isInScope(sanPedroCase(SAN_PEDRO_A), GOVT_SAN_PEDRO_A_UNIT.jurisdictions)).toBe(true);
  });

  it("a single-locality unit grant with no recorded row still files under its member", async () => {
    const deps = makeDeps();
    await openOutbreakInvestigation(
      { diseaseCode: "rabies", reason: "Casos confirmados en zona", actor: GOVT_SAN_PEDRO_A_UNIT },
      deps,
    );
    expect(deps.openCase).toHaveBeenCalledWith(
      expect.objectContaining({ localityId: SAN_PEDRO_A }),
      "fake-tx",
    );
  });

  it("a recorded row the unit no longer governs is not used", async () => {
    const deps = makeDeps({ findGrantLocalityId: vi.fn().mockResolvedValue(SAN_PEDRO_B) });
    await openOutbreakInvestigation(
      { diseaseCode: "rabies", reason: "Casos confirmados en zona", actor: GOVT_SAN_PEDRO_A_UNIT },
      deps,
    );
    expect(deps.openCase).toHaveBeenCalledWith(
      expect.objectContaining({ localityId: SAN_PEDRO_A }),
      "fake-tx",
    );
  });

  it("a legacy homonym grant with no recorded row stays NULL (name names two rows)", async () => {
    const deps = makeDeps();
    await openOutbreakInvestigation(
      {
        diseaseCode: "rabies",
        reason: "Casos confirmados en zona",
        actor: {
          profile: { id: "govt-legacy", role: "govt" as const },
          jurisdictions: [{ province: "Córdoba", locality: "San Pedro" }],
        },
      },
      deps,
    );
    expect(deps.openCase).toHaveBeenCalledWith(
      expect.objectContaining({ jurisdictionLocality: "San Pedro", localityId: null }),
      "fake-tx",
    );
  });

  it("a whole-CABA grant opens a province-level case pinned to no row", async () => {
    const deps = makeDeps({ findGrantLocalityId: vi.fn().mockResolvedValue("loc-whatever") });
    await openOutbreakInvestigation(
      {
        diseaseCode: "rabies",
        reason: "Casos confirmados en zona",
        actor: {
          profile: { id: "govt-caba", role: "govt" as const },
          jurisdictions: [{ province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" }],
        },
      },
      deps,
    );
    expect(deps.openCase).toHaveBeenCalledWith(
      expect.objectContaining({ jurisdictionProvince: "CABA", localityId: null }),
      "fake-tx",
    );
    expect(deps.repo.findGrantLocalityId).not.toHaveBeenCalled();
    expect(deps.resolveLocalityId).not.toHaveBeenCalled();
  });

  it("several grants: the choice is stable whatever order they arrive in, widest first", () => {
    const palermo = { province: "CABA", locality: "Palermo" };
    const recoleta = { province: "CABA", locality: "Recoleta" };
    const wholeCaba = { province: "CABA", locality: "Ciudad Autónoma de Buenos Aires" };
    const laPlata = { province: "Buenos Aires", locality: "La Plata" };
    expect(openerGrant([recoleta, palermo])).toBe(palermo);
    expect(openerGrant([palermo, recoleta])).toBe(palermo);
    expect(openerGrant([palermo, laPlata])).toBe(laPlata);
    expect(openerGrant([laPlata, palermo])).toBe(laPlata);
    expect(openerGrant([palermo, wholeCaba, laPlata])).toBe(wholeCaba);
    expect(openerGrant([])).toBeNull();
  });
});
