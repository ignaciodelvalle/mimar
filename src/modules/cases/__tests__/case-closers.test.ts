// Unit tests for the 4 case-closer use-cases (WU-3, Task 3.6).
//
// Layer: Unit (fake transaction — no DB required).
// TDD: RED written first — application/*.ts files do not exist yet.
//
// Strategy: mock @/db with a controllable fake that captures insert calls.
// The tx.insert spy captures ALL inserts; we distinguish by the data shape
// (petEvents have eventType, notifications have notificationType).
//
// Invariants per spec (C1–C4):
//   - Anti-race: processOne does nothing when 0 rows updated (AND status='open' guard).
//   - System actor: authorRole='system', recordedByUserId=null, authorVerified=false.
//   - Exact Spanish note text (C1, C2).
//   - Notification fan-out: disputes → govt ∪ institutional admins; welfare → govt only.
//   - Welfare escalation does NOT touch welfare_reports.status.
//   - C1 closed_reason=resolved, C2 closed_reason=auto_expired.

import { beforeEach, describe, expect, it, vi } from "vitest";

// --------------------------------------------------------------------------
// Shared state captured across tests
// --------------------------------------------------------------------------

const insertedRows: Record<string, unknown>[][] = [];
let updateRowCount = 1; // default: 1 row updated (proceed with side effects)

function resetState() {
  insertedRows.length = 0;
  updateRowCount = 1;
}

// Build a fake transaction that captures inserts and respects updateRowCount.
function makeTx() {
  return {
    update: (_t: unknown) => ({
      set: (_d: unknown) => ({
        where: (_w: unknown) => ({
          returning: (_f: unknown) => Promise.resolve(updateRowCount > 0 ? [{ id: "case-1" }] : []),
        }),
      }),
    }),
    insert: (_t: unknown) => ({
      values: (data: unknown) => {
        const rows = Array.isArray(data) ? data : [data];
        insertedRows.push(rows as Record<string, unknown>[]);
        // Awaitable AND chainable: writeAuditLog (lib/infra/audit-log.ts) ends
        // its insert with `.returning({ id })`, every other writer just awaits.
        const result = Promise.resolve() as Promise<unknown> & {
          returning: (fields?: unknown) => Promise<{ id: string }[]>;
        };
        result.returning = () => Promise.resolve([{ id: "audit-row-1" }]);
        return result;
      },
    }),
  };
}

// Fake db that always uses the same tx
const fakeTx = makeTx();
const fakeDb = {
  transaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb(fakeTx),
  select: (_: unknown) => ({
    from: (_: unknown) => ({
      where: (_: unknown) => Promise.resolve([] as { id: string }[]),
      leftJoin: (_: unknown) => ({
        where: (_: unknown) => Promise.resolve([]),
      }),
    }),
  }),
};

// --------------------------------------------------------------------------
// Module mocks — declared before any imports that trigger the modules
// --------------------------------------------------------------------------

vi.mock("@/db", () => ({
  db: fakeDb,
  auditLog: Symbol("auditLog"),
  cases: Symbol("cases"),
  petEvents: Symbol("petEvents"),
  notifications: Symbol("notifications"),
  profiles: Symbol("profiles"),
  welfareReports: Symbol("welfareReports"),
}));

vi.mock("@/lib/events/event-schemas", () => ({
  validateEventPayload: (_type: string, payload: unknown) => payload,
}));

const mockFindAuthorities = vi.fn().mockResolvedValue([] as string[]);
vi.mock("@/lib/infra/approval-routing", () => ({
  findAuthoritiesForJurisdiction: (args: unknown) => mockFindAuthorities(args),
}));

// --------------------------------------------------------------------------
// Helpers to inspect captured inserts
// --------------------------------------------------------------------------

function allInserted(): Record<string, unknown>[] {
  return insertedRows.flat();
}

function petEventRows() {
  return allInserted().filter((r) => "eventType" in r);
}

function notificationRows() {
  return allInserted().filter((r) => "notificationType" in r);
}

function auditRows() {
  return allInserted().filter((r) => "action" in r);
}

// --------------------------------------------------------------------------
// C1 — close-followup-expired-adoptions
// --------------------------------------------------------------------------

describe("close-followup-expired-adoptions (use-case)", () => {
  beforeEach(() => {
    resetState();
    mockFindAuthorities.mockResolvedValue([]);
  });

  it("processOne closes the case and emits system note_added when primaryPetId is set", async () => {
    const { closeFollowupExpiredAdoption } = await import(
      "@/src/modules/cases/application/close-followup-expired-adoptions"
    );

    await closeFollowupExpiredAdoption({
      id: "case-1",
      primaryPetId: "pet-1",
      publicCode: "CAS-ADOPT",
    });

    const events = petEventRows();
    expect(events.length).toBe(1);
    const evt = events[0];
    expect(evt.eventType).toBe("note_added");
    expect(evt.authorRole).toBe("system");
    expect(evt.recordedByUserId).toBeNull();
    expect(evt.authorVerified).toBe(false);
    expect(evt.petId).toBe("pet-1");
    expect(evt.caseId).toBe("case-1");
    const payload = evt.payload as Record<string, unknown>;
    expect(payload.category).toBe("system");
    expect(payload.text).toBe(
      "Adopción completada — ventana de seguimiento finalizada. La mascota queda integrada al hogar adoptante.",
    );
  });

  it("processOne does NOT emit note_added when primaryPetId is null", async () => {
    const { closeFollowupExpiredAdoption } = await import(
      "@/src/modules/cases/application/close-followup-expired-adoptions"
    );

    await closeFollowupExpiredAdoption({ id: "case-1", primaryPetId: null, publicCode: "CAS-X" });

    expect(petEventRows().length).toBe(0);
  });

  it("anti-race: processOne emits nothing when 0 rows updated (already closed)", async () => {
    updateRowCount = 0;
    const { closeFollowupExpiredAdoption } = await import(
      "@/src/modules/cases/application/close-followup-expired-adoptions"
    );

    await closeFollowupExpiredAdoption({
      id: "case-1",
      primaryPetId: "pet-1",
      publicCode: "CAS-X",
    });

    expect(petEventRows().length).toBe(0);
  });
});

// --------------------------------------------------------------------------
// C2 — close-stale-lost-episodes
// --------------------------------------------------------------------------

describe("close-stale-lost-episodes (use-case)", () => {
  beforeEach(() => {
    resetState();
  });

  it("processOne emits system note_added with exact Spanish text (C2 copy)", async () => {
    const { closeStaleLostEpisode } = await import(
      "@/src/modules/cases/application/close-stale-lost-episodes"
    );

    await closeStaleLostEpisode({ id: "case-2", primaryPetId: "pet-2", publicCode: "CAS-LOST" });

    const events = petEventRows();
    expect(events.length).toBe(1);
    const evt = events[0];
    expect(evt.eventType).toBe("note_added");
    expect(evt.authorRole).toBe("system");
    expect(evt.recordedByUserId).toBeNull();
    expect(evt.authorVerified).toBe(false);
    const payload = evt.payload as Record<string, unknown>;
    expect(payload.category).toBe("system");
    expect(payload.text).toBe(
      "Caso cerrado automáticamente por inactividad. La mascota sigue marcada perdida; el dueño puede reactivar reportándola encontrada o marcándola nuevamente como perdida.",
    );
  });

  it("processOne does NOT emit note_added when primaryPetId is null", async () => {
    const { closeStaleLostEpisode } = await import(
      "@/src/modules/cases/application/close-stale-lost-episodes"
    );

    await closeStaleLostEpisode({ id: "case-2", primaryPetId: null, publicCode: "CAS-X" });

    expect(petEventRows().length).toBe(0);
  });

  it("anti-race: no note emitted when 0 rows updated", async () => {
    updateRowCount = 0;
    const { closeStaleLostEpisode } = await import(
      "@/src/modules/cases/application/close-stale-lost-episodes"
    );

    await closeStaleLostEpisode({ id: "case-2", primaryPetId: "pet-2", publicCode: "CAS-X" });

    expect(petEventRows().length).toBe(0);
  });
});

// --------------------------------------------------------------------------
// C3 — escalate-stale-disputes
// --------------------------------------------------------------------------

describe("escalate-stale-disputes (use-case)", () => {
  beforeEach(() => {
    resetState();
    mockFindAuthorities.mockResolvedValue([]);
  });

  it("fan-out: sends notifications to govt ∪ institutional admins with exact type+severity", async () => {
    mockFindAuthorities.mockResolvedValue(["govt-1"]);
    // Patch db.select to return one institutional admin for this test
    const origSelect = fakeDb.select;
    (fakeDb as unknown as { select: unknown }).select = (_: unknown) => ({
      from: (_: unknown) => ({
        where: (_: unknown) => Promise.resolve([{ id: "admin-1" }]),
        leftJoin: (_: unknown) => ({ where: (_: unknown) => Promise.resolve([]) }),
      }),
    });

    const { escalateStaleDispute } = await import(
      "@/src/modules/cases/application/escalate-stale-disputes"
    );

    await escalateStaleDispute({
      id: "case-3",
      publicCode: "CAS-DISP",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Mar del Plata",
    });

    // Restore
    (fakeDb as unknown as { select: unknown }).select = origSelect;

    const notifs = notificationRows();
    expect(notifs.length).toBe(2); // govt-1 + admin-1 (set deduplication preserves both)
    const userIds = notifs.map((n) => n.userId);
    expect(userIds).toContain("govt-1");
    expect(userIds).toContain("admin-1");
    // All notifications have the correct type/severity
    for (const n of notifs) {
      expect(n.notificationType).toBe("custody_dispute_stale");
      expect(n.severity).toBe("warning");
      expect(n.title).toBe("Disputa de custodia >1 año");
      expect(n.relatedCaseId).toBe("case-3");
    }
  });

  it("deduplication: govt authority appearing in admin list counted once", async () => {
    // Same id appears in both govt and admin result
    mockFindAuthorities.mockResolvedValue(["shared-id"]);
    const origSelect = fakeDb.select;
    (fakeDb as unknown as { select: unknown }).select = (_: unknown) => ({
      from: (_: unknown) => ({
        where: (_: unknown) => Promise.resolve([{ id: "shared-id" }]),
        leftJoin: (_: unknown) => ({ where: (_: unknown) => Promise.resolve([]) }),
      }),
    });

    const { escalateStaleDispute } = await import(
      "@/src/modules/cases/application/escalate-stale-disputes"
    );

    await escalateStaleDispute({
      id: "case-3b",
      publicCode: "CAS-DISP-B",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Mar del Plata",
    });

    (fakeDb as unknown as { select: unknown }).select = origSelect;

    // Only 1 notification despite appearing in both lists
    const notifs = notificationRows();
    expect(notifs.length).toBe(1);
    expect(notifs[0].userId).toBe("shared-id");
  });

  it("anti-race: no notifications when 0 rows updated", async () => {
    updateRowCount = 0;
    mockFindAuthorities.mockResolvedValue(["govt-1"]);

    const { escalateStaleDispute } = await import(
      "@/src/modules/cases/application/escalate-stale-disputes"
    );

    await escalateStaleDispute({
      id: "case-3",
      publicCode: "CAS-X",
      jurisdictionProvince: null,
      jurisdictionLocality: null,
    });

    expect(notificationRows().length).toBe(0);
  });

  it("no notifications when recipients list is empty — but the empty fan-out IS traced", async () => {
    // No govt authorities, no admins. The case still transitions to `escalated`,
    // and `escalated` has no worklist of its own, so without the audit row the
    // dispute would simply stop being anywhere (routing audit, 2026-08-17).
    const { escalateStaleDispute } = await import(
      "@/src/modules/cases/application/escalate-stale-disputes"
    );

    await escalateStaleDispute({
      id: "case-3",
      publicCode: "CAS-X",
      jurisdictionProvince: null,
      jurisdictionLocality: null,
    });

    expect(notificationRows().length).toBe(0);

    const trace = auditRows().find((r) => r.action === "notification_fanout_empty");
    expect(trace, "an empty fan-out must leave a trace").toBeDefined();
    expect(trace?.payload).toMatchObject({
      route: "custody_dispute_stale",
      reason: "no_govt_no_admin",
      case_public_code: "CAS-X",
    });
  });

  it("a null jurisdiction still CALLS the resolver — the admin fallback must get its chance", async () => {
    // The guard this replaces (`prov && loc ? … : []`) never called the
    // resolver, so the one real fallback in the system never ran for a case
    // with no geocoded jurisdiction.
    const { escalateStaleDispute } = await import(
      "@/src/modules/cases/application/escalate-stale-disputes"
    );

    mockFindAuthorities.mockClear();
    await escalateStaleDispute({
      id: "case-4",
      publicCode: "CAS-Y",
      jurisdictionProvince: null,
      jurisdictionLocality: null,
    });

    expect(mockFindAuthorities).toHaveBeenCalledWith({ province: "", locality: "" });
  });
});

// --------------------------------------------------------------------------
// C4 — escalate-stale-welfare-cases
// --------------------------------------------------------------------------

describe("escalate-stale-welfare-cases (use-case)", () => {
  beforeEach(() => {
    resetState();
    mockFindAuthorities.mockResolvedValue([]);
  });

  it("fan-out: sends notifications to govt authorities ONLY (not institutional admins)", async () => {
    mockFindAuthorities.mockResolvedValue(["govt-welfare-1"]);

    const { escalateStaleWelfareCase } = await import(
      "@/src/modules/cases/application/escalate-stale-welfare-cases"
    );

    await escalateStaleWelfareCase({
      id: "case-4",
      publicCode: "CAS-WELF",
      welfareReportId: "wr-1",
      referenceCode: "DEN-AAAA",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Mar del Plata",
    });

    const notifs = notificationRows();
    expect(notifs.length).toBe(1);
    expect(notifs[0].userId).toBe("govt-welfare-1");
    expect(notifs[0].notificationType).toBe("welfare_denuncia_stale_govt");
    expect(notifs[0].severity).toBe("warning");
    expect(notifs[0].title).toBe("Denuncia inactiva >90 días");
    expect(notifs[0].relatedCaseId).toBe("case-4");
  });

  it("uses referenceCode in body, falling back to publicCode when referenceCode is null", async () => {
    mockFindAuthorities.mockResolvedValue(["govt-1"]);

    const { escalateStaleWelfareCase } = await import(
      "@/src/modules/cases/application/escalate-stale-welfare-cases"
    );

    await escalateStaleWelfareCase({
      id: "case-4b",
      publicCode: "CAS-WELF-B",
      welfareReportId: "wr-2",
      referenceCode: null,
      // Must provide jurisdiction so findAuthoritiesForJurisdiction is called
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Mar del Plata",
    });

    const notifs = notificationRows();
    expect(notifs.length).toBe(1);
    // Falls back to publicCode when referenceCode is null
    const body = notifs[0].body as string;
    expect(body).toContain("CAS-WELF-B");
  });

  it("does NOT insert into welfare_reports (no mutation of sensitive table)", async () => {
    mockFindAuthorities.mockResolvedValue(["govt-1"]);

    const insertSpy = vi.spyOn(fakeTx, "insert");

    const { escalateStaleWelfareCase } = await import(
      "@/src/modules/cases/application/escalate-stale-welfare-cases"
    );

    // Get welfareReports symbol from mock
    const dbModule = await import("@/db");
    const welfareReportsRef = dbModule.welfareReports;

    await escalateStaleWelfareCase({
      id: "case-4",
      publicCode: "CAS-WELF",
      welfareReportId: "wr-1",
      referenceCode: "DEN-AAAA",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Mar del Plata",
    });

    // No call to insert should pass the welfareReports table
    const insertedTables = insertSpy.mock.calls.map((call) => call[0]);
    expect(insertedTables).not.toContain(welfareReportsRef);

    insertSpy.mockRestore();
  });

  it("anti-race: no notifications when 0 rows updated", async () => {
    updateRowCount = 0;
    mockFindAuthorities.mockResolvedValue(["govt-1"]);

    const { escalateStaleWelfareCase } = await import(
      "@/src/modules/cases/application/escalate-stale-welfare-cases"
    );

    await escalateStaleWelfareCase({
      id: "case-4",
      publicCode: "CAS-X",
      welfareReportId: null,
      referenceCode: null,
      jurisdictionProvince: null,
      jurisdictionLocality: null,
    });

    expect(notificationRows().length).toBe(0);
  });
});
