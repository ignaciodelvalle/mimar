// Unit tests for createOrgWelfareReport use-case.
// Spec R2 — org create: OA9 escalation, OA4 fan-out, audit_log presence,
// auth-scope rejection (wrong-org/under-verified/wrong-role).
//
// All DB/repo calls mocked. No Postgres required.

import { describe, expect, it, vi } from "vitest";

import type { OpenedReason } from "@/src/modules/cases/domain/opened-reason";
import type { WelfareRepository } from "../../infrastructure/welfare-repository";
import { createOrgWelfareReport } from "../create-org-welfare-report";

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

type OpenCaseFn = (input: {
  kind: string;
  primarySubjectKind: string;
  primaryPetId: string | null;
  locationLat: string | null;
  locationLng: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  openedByUserId: string;
  openedByOrganizationId: string;
  openedReason: OpenedReason;
  welfareReportId: string;
}) => Promise<{ id: string; publicCode: string }>;

type SignalFn = (opts: {
  reportId: string;
  kind: string;
  severity: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  hasContact: boolean;
}) => Promise<void>;

// Use valid RFC 4122 v4 UUIDs — validateEventPayload schema uses z.string().uuid().
const RPT_ID = "c3d4e5f6-a7b8-4333-aced-333333333333";
const PET_ID = "d4e5f6a7-b8c9-4444-bcde-444444444444";
const ORIG_CASE_ID = "e5f6a7b8-c9da-4555-cdef-555555555555";

function makeRepo(
  overrides: Partial<WelfareRepository> = {},
): Pick<
  WelfareRepository,
  | "insertAttachments"
  | "linkCase"
  | "insertPetEvent"
  | "insertPetEventIdempotent"
  | "insertAudit"
  | "insertNotifications"
  | "findOpenOtherWelfareCasesForPet"
  | "findInstitutionalAdmins"
> {
  return {
    insertAttachments: vi.fn().mockResolvedValue(undefined),
    linkCase: vi.fn().mockResolvedValue(undefined),
    insertPetEvent: vi.fn().mockResolvedValue(undefined),
    insertPetEventIdempotent: vi.fn().mockResolvedValue({ wasNoop: false }),
    insertAudit: vi.fn().mockResolvedValue(undefined),
    insertNotifications: vi.fn().mockResolvedValue(undefined),
    findOpenOtherWelfareCasesForPet: vi.fn().mockResolvedValue([]),
    findInstitutionalAdmins: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as Pick<
    WelfareRepository,
    | "insertAttachments"
    | "linkCase"
    | "insertPetEvent"
    | "insertPetEventIdempotent"
    | "insertAudit"
    | "insertNotifications"
    | "findOpenOtherWelfareCasesForPet"
    | "findInstitutionalAdmins"
  >;
}

function makeDeps(repoOverrides: Partial<WelfareRepository> = {}) {
  const repo = makeRepo(repoOverrides);
  const openCase: OpenCaseFn = vi.fn().mockResolvedValue({ id: "case-002", publicCode: "C-002" });
  const findGovtRecipients = vi.fn().mockResolvedValue([]);
  const signal: SignalFn = vi.fn().mockResolvedValue(undefined);
  const transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
    await cb({});
  });

  return { repo, openCase, findGovtRecipients, signal, transaction };
}

/** Every notification row the use-case handed to the repo, flattened. */
function insertedNotifications(repo: {
  insertNotifications: unknown;
}): { notificationType?: string; body?: string }[] {
  const calls = (repo.insertNotifications as ReturnType<typeof vi.fn>).mock.calls;
  return calls.flatMap((c) => (c[0] ?? []) as { notificationType?: string; body?: string }[]);
}

const ORG_MEMBER = {
  userId: "user-org-01",
  orgId: "org-001",
  orgDisplayName: "Refugio Patitas",
  orgVerified: true,
  memberRole: "coordinator" as const,
};

const BASE_INPUT = {
  reportId: RPT_ID,
  referenceCode: "DEN-ORGG-01",
  kind: "neglect" as const,
  severity: "critical" as const, // server-forced; use-case re-enforces
  description:
    "Hemos documentado durante 30 días la situación de un animal sin alimentación ni agua en las instalaciones del criadero ubicado en la zona sur de la localidad.",
  subjectKind: "unowned_animal" as const,
  subjectPetId: null as string | null,
  subjectDescription: "Animal sin dueño identificado en criadero.",
  locationAddress: null,
  jurisdictionProvince: "Buenos Aires" as string | null,
  jurisdictionLocality: "Mar del Plata" as string | null,
  locationLat: null as string | null,
  locationLng: null as string | null,
  occurredAt: null as Date | null,
  observedSymptoms: null as string | null,
  attachments: [
    {
      storagePath: "welfare-evidence/c3d4e5f6-a7b8-4333-aced-333333333333/evidence.jpg",
      mimeType: "image/jpeg",
      fileSize: 2048,
      originalFilename: "evidencia.jpg",
    },
  ] as Array<{
    storagePath: string;
    mimeType: string;
    fileSize: number;
    originalFilename: string | null;
  }>,
  uploadedPaths: ["welfare-evidence/c3d4e5f6-a7b8-4333-aced-333333333333/evidence.jpg"],
  orgMember: ORG_MEMBER,
  clientIdempotencyKey: null as string | null,
};

// ---------------------------------------------------------------------------
// Tests — audit_log (MUST be present for org-create, spec R2)
// ---------------------------------------------------------------------------

describe("createOrgWelfareReport — audit_log presence (spec R2 REQUIRED)", () => {
  it("inserts audit_log with action=welfare_report_submitted_by_org inside tx", async () => {
    const { repo, openCase, findGovtRecipients, signal, transaction } = makeDeps();

    const result = await createOrgWelfareReport(BASE_INPUT, {
      repo,
      openCase,
      findGovtRecipients,
      signal,
      transaction,
    });

    expect(result.ok).toBe(true);
    // Located by action, not by call index: this fixture has no recipients at
    // all, so an empty-fan-out trace is legitimately written alongside it.
    const auditCalls = (repo.insertAudit as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as { action: string },
    );
    const submitted = auditCalls.find((a) => a.action === "welfare_report_submitted_by_org");
    expect(submitted).toBeDefined();
    expect(submitted).toMatchObject({
      actorUserId: ORG_MEMBER.userId,
      action: "welfare_report_submitted_by_org",
      payload: expect.objectContaining({
        organizationId: ORG_MEMBER.orgId,
        organizationName: ORG_MEMBER.orgDisplayName,
        welfareReportId: RPT_ID,
        subjectKind: BASE_INPUT.subjectKind,
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — the reporter confirmation must not lie about delivery
// ---------------------------------------------------------------------------

describe("createOrgWelfareReport — the confirmation follows the fact", () => {
  it("does NOT claim the authorities were notified when NOBODY was, and traces it", async () => {
    // The old copy asserted "Las autoridades en jurisdicción ya fueron
    // notificadas" unconditionally. That is worse than silence: an affirmative
    // "ya está avisado" suppresses the phone call the reporter would otherwise
    // make (routing audit, 2026-08-17).
    const { repo, openCase, findGovtRecipients, signal, transaction } = makeDeps();

    const result = await createOrgWelfareReport(BASE_INPUT, {
      repo,
      openCase,
      findGovtRecipients,
      signal,
      transaction,
    });

    expect(result.ok).toBe(true);

    const confirmation = insertedNotifications(repo).find(
      (n) => n.notificationType === "welfare_org_side_confirmed_reporter",
    );
    expect(confirmation).toBeDefined();
    expect(confirmation?.body).not.toContain("ya fueron notificadas");
    expect(confirmation?.body).toContain("Todavía no pudimos avisar");

    const auditCalls = (repo.insertAudit as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as { action: string; payload: Record<string, unknown> },
    );
    const trace = auditCalls.find((a) => a.action === "notification_fanout_empty");
    expect(trace, "an empty fan-out must leave a trace").toBeDefined();
    expect(trace?.payload).toMatchObject({
      route: "welfare_org_side_critical_received",
      reason: "no_govt_no_admin",
    });
  });

  it("DOES say the authorities were notified when somebody actually was", async () => {
    const { repo, openCase, signal, transaction } = makeDeps();
    const findGovtRecipients = vi.fn().mockResolvedValue(["govt-user-1"]);

    const result = await createOrgWelfareReport(BASE_INPUT, {
      repo,
      openCase,
      findGovtRecipients,
      signal,
      transaction,
    });

    expect(result.ok).toBe(true);

    const confirmation = insertedNotifications(repo).find(
      (n) => n.notificationType === "welfare_org_side_confirmed_reporter",
    );
    expect(confirmation?.body).toContain("ya fueron notificadas");

    const auditCalls = (repo.insertAudit as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as { action: string },
    );
    expect(auditCalls.some((a) => a.action === "notification_fanout_empty")).toBe(false);
  });

  it("calls the resolver even with a null jurisdiction — the admin fallback must get its chance", async () => {
    const { repo, openCase, signal, transaction } = makeDeps();
    const findGovtRecipients = vi.fn().mockResolvedValue([]);

    await createOrgWelfareReport(
      { ...BASE_INPUT, jurisdictionProvince: null, jurisdictionLocality: null },
      { repo, openCase, findGovtRecipients, signal, transaction },
    );

    expect(findGovtRecipients).toHaveBeenCalledWith({ province: "", locality: "" });
  });
});

// ---------------------------------------------------------------------------
// Tests — OA9 multi-source escalation
// ---------------------------------------------------------------------------

describe("createOrgWelfareReport — OA9 multi-source escalation", () => {
  // Pet resolution happens in the ACTION. The use-case receives pre-resolved subjectPetId.

  it("OA9: inserts system note_added on the ORIGINAL case when another open case exists for the same pet", async () => {
    const repo = makeRepo({
      findOpenOtherWelfareCasesForPet: vi
        .fn()
        .mockResolvedValue([{ welfareReportId: RPT_ID, caseId: ORIG_CASE_ID }]),
    });
    const { openCase, findGovtRecipients, signal, transaction } = makeDeps();

    const result = await createOrgWelfareReport(
      {
        ...BASE_INPUT,
        subjectKind: "registered_pet",
        subjectPetId: PET_ID, // pre-resolved
        subjectDescription: null,
      },
      { repo, openCase, findGovtRecipients, signal, transaction },
    );

    expect(result.ok).toBe(true);

    // insertPetEvent called at least once for the system note
    const petEventCalls = (repo.insertPetEvent as ReturnType<typeof vi.fn>).mock.calls;
    const systemNote = petEventCalls.find((call: unknown[]) => {
      const v = call[0] as { eventType: string; authorRole: string };
      return v.eventType === "note_added" && v.authorRole === "system";
    });
    expect(systemNote).toBeDefined();
    // System note goes on the ORIGINAL case, not the new one
    expect(systemNote?.[0]).toMatchObject({
      caseId: ORIG_CASE_ID,
      recordedByUserId: null,
      authorRole: "system",
    });
  });

  it("OA9: no system note inserted when no other open case exists", async () => {
    const repo = makeRepo({
      findOpenOtherWelfareCasesForPet: vi.fn().mockResolvedValue([]),
    });
    const { openCase, findGovtRecipients, signal, transaction } = makeDeps();

    await createOrgWelfareReport(
      {
        ...BASE_INPUT,
        subjectKind: "registered_pet",
        subjectPetId: PET_ID,
        subjectDescription: null,
      },
      { repo, openCase, findGovtRecipients, signal, transaction },
    );

    const petEventCalls = (repo.insertPetEvent as ReturnType<typeof vi.fn>).mock.calls;
    const systemNote = petEventCalls.find(
      (call: unknown[]) => (call[0] as { authorRole: string }).authorRole === "system",
    );
    expect(systemNote).toBeUndefined();
  });

  it("OA9: only runs when subjectKind=registered_pet (not for unowned_animal)", async () => {
    const repo = makeRepo({
      findOpenOtherWelfareCasesForPet: vi
        .fn()
        .mockResolvedValue([{ welfareReportId: RPT_ID, caseId: ORIG_CASE_ID }]),
    });
    const { openCase, findGovtRecipients, signal, transaction } = makeDeps();

    await createOrgWelfareReport(BASE_INPUT, {
      // BASE_INPUT has subjectKind: "unowned_animal", subjectPetId: null
      repo,
      openCase,
      findGovtRecipients,
      signal,
      transaction,
    });

    // No pet event calls for unowned_animal (no petId)
    expect(repo.insertPetEvent).not.toHaveBeenCalled();
    // findOpenOtherWelfareCasesForPet not called either (no petId)
    expect(repo.findOpenOtherWelfareCasesForPet).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — OA4 fan-out (govt ∪ institutional admins, deduped)
// ---------------------------------------------------------------------------

describe("createOrgWelfareReport — OA4 fan-out notifications", () => {
  it("OA4: notifies govt recipients + institutional admins (deduped Set)", async () => {
    // govt=[user-gov-1, user-gov-2], admins=[user-gov-2, user-admin-3] → 3 unique
    const repo = makeRepo({
      findInstitutionalAdmins: vi.fn().mockResolvedValue(["user-gov-2", "user-admin-3"]),
    });
    const findGovtRecipients = vi.fn().mockResolvedValue(["user-gov-1", "user-gov-2"]);
    const { openCase, signal, transaction } = makeDeps();

    const result = await createOrgWelfareReport(BASE_INPUT, {
      repo,
      openCase,
      findGovtRecipients,
      signal,
      transaction,
    });

    expect(result.ok).toBe(true);
    expect(repo.insertNotifications).toHaveBeenCalled();
    const notifRows: Array<{ userId: string; notificationType: string }> = (
      repo.insertNotifications as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];

    // Urgent notifs to the 3 unique recipients
    const urgentNotifs = notifRows.filter(
      (n) => n.notificationType === "welfare_org_side_critical_received",
    );
    const urgentRecipientIds = urgentNotifs.map((n) => n.userId);
    expect(new Set(urgentRecipientIds).size).toBe(urgentRecipientIds.length); // no duplicates
    expect(urgentRecipientIds).toContain("user-gov-1");
    expect(urgentRecipientIds).toContain("user-gov-2");
    expect(urgentRecipientIds).toContain("user-admin-3");
  });

  it("OA4: reporter confirmation always included (welfare_org_side_confirmed_reporter)", async () => {
    const { repo, openCase, findGovtRecipients, signal, transaction } = makeDeps();

    await createOrgWelfareReport(BASE_INPUT, {
      repo,
      openCase,
      findGovtRecipients,
      signal,
      transaction,
    });

    const notifRows: Array<{ userId: string; notificationType: string }> = (
      repo.insertNotifications as ReturnType<typeof vi.fn>
    ).mock.calls[0][0];

    const confirmation = notifRows.find(
      (n) => n.notificationType === "welfare_org_side_confirmed_reporter",
    );
    expect(confirmation).toBeDefined();
    expect(confirmation?.userId).toBe(ORG_MEMBER.userId);
  });

  it("OA4: insertNotifications called POST-tx (best-effort)", async () => {
    const { repo, openCase, findGovtRecipients, signal, transaction } = makeDeps();
    const callOrder: string[] = [];

    const txSpy = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
      callOrder.push("tx-start");
      await cb({});
      callOrder.push("tx-end");
    });
    (repo.insertNotifications as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("notifications");
    });

    await createOrgWelfareReport(BASE_INPUT, {
      repo,
      openCase,
      findGovtRecipients,
      signal,
      transaction: txSpy,
    });

    // notifications must come AFTER tx-end
    const txEndIdx = callOrder.indexOf("tx-end");
    const notifIdx = callOrder.indexOf("notifications");
    expect(notifIdx).toBeGreaterThan(txEndIdx);
  });
});

// ---------------------------------------------------------------------------
// Tests — auth-scope rejection (spec R2: wrong-org/under-verified/wrong-role)
// These are tested at the ACTION layer (actions-create-parity.test.ts).
// Here we verify the use-case enforces severity=critical regardless of input.
// ---------------------------------------------------------------------------

describe("createOrgWelfareReport — severity forced to critical (OA2)", () => {
  it("signal is always called with severity=critical regardless of input", async () => {
    const { repo, openCase, findGovtRecipients, signal, transaction } = makeDeps();

    // Even if the caller passes 'low' (which shouldn't happen but ensures server is authoritative)
    await createOrgWelfareReport(
      { ...BASE_INPUT, severity: "low" as "critical" },
      { repo, openCase, findGovtRecipients, signal, transaction },
    );

    const signalCall = (signal as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(signalCall).toMatchObject({ severity: "critical" });
  });
});

// ---------------------------------------------------------------------------
// Tests — redirect
// ---------------------------------------------------------------------------

describe("createOrgWelfareReport — redirect", () => {
  it("redirects to the EMITIDOS tab carrying the fresh report's reference code", async () => {
    const { repo, openCase, findGovtRecipients, signal, transaction } = makeDeps();

    const result = await createOrgWelfareReport(
      { ...BASE_INPUT, orgToken: "refugio-patitas" },
      { repo, openCase, findGovtRecipients, signal, transaction },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The bare hub URL defaulted to "Recibidos" (usually empty) and gave no
    // confirmation — the report the professional just filed lives in
    // Emitidos, and the `creado` param drives the hub's confirmation banner
    // (9-role external run, 2026-08-18).
    expect(result.redirectTo).toBe(
      `/org/refugio-patitas/maltrato/recibidos?tab=emitidos&creado=${encodeURIComponent(result.referenceCode)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests — signal post-tx
// ---------------------------------------------------------------------------

describe("createOrgWelfareReport — signal", () => {
  it("calls signal post-tx with hasContact=true", async () => {
    const { repo, openCase, findGovtRecipients, signal, transaction } = makeDeps();

    await createOrgWelfareReport(BASE_INPUT, {
      repo,
      openCase,
      findGovtRecipients,
      signal,
      transaction,
    });

    expect(signal).toHaveBeenCalledOnce();
    const signalCall = (signal as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(signalCall).toMatchObject({ hasContact: true, severity: "critical" });
  });
});
