// Unit tests for startWelfareReport use-case.
// Spec R3 — start transitions + audit_log + triage-actor backfill + reporter notification.

import { describe, expect, it, vi } from "vitest";

import type { WelfareReport } from "@/db/schema";
import type { WelfareRepository } from "../../infrastructure/welfare-repository";
import { startWelfareReport } from "../start-welfare-report";

function makeReport(overrides: Partial<WelfareReport> = {}): WelfareReport {
  return {
    id: "rpt-001",
    referenceCode: "DEN-TEST-001",
    status: "open",
    reporterUserId: "user-reporter-01",
    caseId: "case-001",
    triagedAt: null,
    triagedByUserId: null,
    closedAt: null,
    resolutionNotes: null,
    moderationResolvedAt: null,
    moderationResolvedByUserId: null,
    flaggedAt: null,
    flagReasons: [],
    assignedToUserId: null,
    subjectPetId: null,
    kind: "neglect",
    severity: "medium",
    subjectKind: "unowned_animal",
    subjectDescription: "Un perro callejero",
    description: "El animal parece estar desnutrido y sin agua.",
    observedSymptoms: null,
    occurredAt: null,
    locationAddress: null,
    locationLat: null,
    locationLng: null,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "CABA",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as WelfareReport;
}

function makeDeps(reportOverride?: Partial<WelfareReport>) {
  const report = makeReport(reportOverride);
  const repo = {
    findById: vi.fn().mockResolvedValue(report),
    // 1 = "the compare-and-swap matched the row". The old mock resolved
    // `undefined`, which the use-case could not distinguish from a lost race.
    updateStatus: vi.fn().mockResolvedValue(1),
    insertAudit: vi.fn().mockResolvedValue(undefined),
  } as unknown as WelfareRepository;
  const transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
    await cb({});
  });
  const actor = { user: { id: "admin-user-01" }, profile: { role: "admin" as const } };
  return { repo, transaction, actor, report };
}

describe("startWelfareReport — valid transitions", () => {
  it("open → in_progress: updates status + audit_log + reporter notification", async () => {
    const { repo, transaction, actor } = makeDeps();

    const result = await startWelfareReport(
      { welfareReportId: "rpt-001", notes: "Iniciando seguimiento del caso." },
      { repo, transaction, actor },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(repo.insertAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "welfare_report_started" }),
      expect.anything(),
    );
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].notificationType).toBe("welfare_report_status_changed");
  });

  it("triaged → in_progress: allowed", async () => {
    const { repo, transaction, actor } = makeDeps({ status: "triaged" });

    const result = await startWelfareReport(
      { welfareReportId: "rpt-001", notes: "Continuando con el seguimiento." },
      { repo, transaction, actor },
    );

    expect(result.ok).toBe(true);
  });

  it("open → in_progress backfills triagedAt when null (triage-skipped)", async () => {
    const { repo, transaction, actor } = makeDeps({ status: "open", triagedAt: null });

    await startWelfareReport(
      { welfareReportId: "rpt-001", notes: "Iniciando sin triage previo." },
      { repo, transaction, actor },
    );

    const updateCall = (repo.updateStatus as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updateCall[1]).toEqual(
      expect.objectContaining({ triagedAt: expect.any(Date), triagedByUserId: "admin-user-01" }),
    );
  });

  it("does NOT backfill triagedAt when already set", async () => {
    const existingDate = new Date("2026-01-10");
    const { repo, transaction, actor } = makeDeps({
      status: "triaged",
      triagedAt: existingDate,
      triagedByUserId: "other-admin",
    });

    await startWelfareReport(
      { welfareReportId: "rpt-001", notes: "Triage ya hecho, iniciando." },
      { repo, transaction, actor },
    );

    const updateCall = (repo.updateStatus as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updateCall[1]).not.toHaveProperty("triagedAt");
    expect(updateCall[1]).not.toHaveProperty("triagedByUserId");
  });
});

describe("startWelfareReport — guard failures", () => {
  it("notes too short → error, no repo call", async () => {
    const { repo, transaction, actor } = makeDeps();
    const result = await startWelfareReport(
      { welfareReportId: "rpt-001", notes: "Corto" },
      { repo, transaction, actor },
    );
    expect(result.ok).toBe(false);
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it("in_progress → in_progress is illegal", async () => {
    const { repo, transaction, actor } = makeDeps({ status: "in_progress" });
    const result = await startWelfareReport(
      { welfareReportId: "rpt-001", notes: "Intentando re-iniciar denuncia." },
      { repo, transaction, actor },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/in_progress/);
  });

  it("closed → in_progress is illegal (terminal)", async () => {
    const { repo, transaction, actor } = makeDeps({ status: "closed" });
    const result = await startWelfareReport(
      { welfareReportId: "rpt-001", notes: "Intentando reabrir caso cerrado." },
      { repo, transaction, actor },
    );
    expect(result.ok).toBe(false);
  });

  it("anon reporter → no notification", async () => {
    const { repo, transaction, actor } = makeDeps({ reporterUserId: null });
    const result = await startWelfareReport(
      { welfareReportId: "rpt-001", notes: "Caso anónimo iniciado ahora." },
      { repo, transaction, actor },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notifications).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DOUBLE SUBMIT (staging validation 2026-08-01, bug 2). "Iniciar seguimiento"
// leaves the screen on the route-level "Cargando…" skeleton after a 200, and a
// funcionario clicks again. This is the circuit with the most legal weight in
// the system (Ley 14.346), so "does the second click append a second record?"
// needs an answer that is asserted, not reasoned about.
//
// The fixtures above cannot answer it: `findById` returns a FIXED report no
// matter what was written, so every test is the first click by construction.
// These use a mutable fake that actually remembers the write.
// ---------------------------------------------------------------------------

type FakeStore = { status: WelfareReport["status"]; audits: string[] };

function makeStatefulDeps(initial: WelfareReport["status"] = "open") {
  const store: FakeStore = { status: initial, audits: [] };
  const repo = {
    findById: vi.fn(async () => makeReport({ status: store.status })),
    // Honours expectedStatus exactly as the SQL does: the UPDATE matches only
    // while the row is still in the state the caller validated.
    updateStatus: vi.fn(
      async (
        _id: string,
        patch: { status?: WelfareReport["status"] },
        _tx?: unknown,
        opts: { expectedStatus?: WelfareReport["status"] } = {},
      ) => {
        if (opts.expectedStatus !== undefined && opts.expectedStatus !== store.status) return 0;
        if (patch.status) store.status = patch.status;
        return 1;
      },
    ),
    insertAudit: vi.fn(async (row: { action: string }) => {
      store.audits.push(row.action);
    }),
  } as unknown as WelfareRepository;
  const transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
    await cb({});
  });
  const actor = { user: { id: "admin-user-01" }, profile: { role: "admin" as const } };
  return { repo, transaction, actor, store };
}

describe("startWelfareReport — a second click never appends a second record", () => {
  const input = { welfareReportId: "rpt-001", notes: "Iniciando seguimiento del caso." };

  it("sequential double click: the second call is rejected and writes nothing", async () => {
    const { repo, transaction, actor, store } = makeStatefulDeps("open");

    const first = await startWelfareReport(input, { repo, transaction, actor });
    const second = await startWelfareReport(input, { repo, transaction, actor });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    // The audit trail is what a fiscal reads. Exactly one entry.
    expect(store.audits).toEqual(["welfare_report_started"]);
    expect(store.status).toBe("in_progress");
  });

  it("the second click is refused by the state machine, before any write", async () => {
    const { repo, transaction, actor } = makeStatefulDeps("open");
    await startWelfareReport(input, { repo, transaction, actor });
    const second = await startWelfareReport(input, { repo, transaction, actor });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatch(/in_progress/);
  });

  it("THE RACE: two clicks that both read 'open' still produce one audit row", async () => {
    // Both invocations complete their findById + transition check against the
    // pre-transition status — the window the sequential guard cannot see. Only
    // the compare-and-swap inside the transaction separates them.
    const { repo, transaction, actor, store } = makeStatefulDeps("open");

    const [a, b] = await Promise.all([
      startWelfareReport(input, { repo, transaction, actor }),
      startWelfareReport(input, { repo, transaction, actor }),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(store.audits).toEqual(["welfare_report_started"]);
  });

  it("the loser of the race gets a refresh message, not a raw DB error", async () => {
    const { repo, transaction, actor } = makeStatefulDeps("open");
    const results = await Promise.all([
      startWelfareReport(input, { repo, transaction, actor }),
      startWelfareReport(input, { repo, transaction, actor }),
    ]);
    const loser = results.find((r) => !r.ok);
    expect(loser).toBeDefined();
    if (!loser || loser.ok) return;
    expect(loser.error).toContain("Actualizá la página");
    expect(loser.error).not.toMatch(/No se pudo iniciar/);
  });

  it("a lost race appends NO audit row (the transaction aborts before insertAudit)", async () => {
    // Repo that always loses the swap — the state the second writer meets.
    const store: FakeStore = { status: "open", audits: [] };
    const repo = {
      findById: vi.fn(async () => makeReport({ status: "open" })),
      updateStatus: vi.fn(async () => 0),
      insertAudit: vi.fn(async (row: { action: string }) => {
        store.audits.push(row.action);
      }),
    } as unknown as WelfareRepository;
    const transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      await cb({});
    });
    const actor = { user: { id: "admin-user-01" }, profile: { role: "admin" as const } };

    const result = await startWelfareReport(input, { repo, transaction, actor });

    expect(result.ok).toBe(false);
    expect(repo.insertAudit).not.toHaveBeenCalled();
    expect(store.audits).toEqual([]);
  });

  it("a winning call still passes the status it validated as the swap condition", async () => {
    const { repo, transaction, actor } = makeStatefulDeps("triaged");
    await startWelfareReport(input, { repo, transaction, actor });

    const call = (repo.updateStatus as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[3]).toEqual({ expectedStatus: "triaged" });
  });
});
