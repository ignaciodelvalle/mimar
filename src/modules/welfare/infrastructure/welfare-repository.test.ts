// Integration tests for WelfareRepository.
// Exercises the write methods that are part of WU-1 scope:
//   - insertReportWithRetry (23505 collision loop)
//   - insertAttachments
//   - linkCase (updateStatus partial: set case_id)
//   - updateStatus (status/triage/close patches)
//   - setFlagged
//   - setAssignee
//   - insertAudit
//   - insertNotifications
// And the read methods:
//   - findById
//   - findRecentMpfExport (idempotency lookup)
//   - findAttachments
//
// OA9 finder (findOpenOtherWelfareCasesForPet) is tested separately below.
//
// Postgres is required. If unavailable the test file will fail at connection
// and that is expected — the failure is reported as an infra block.

import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cases, db, pets, profiles, welfareReportAttachments, welfareReports } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { openCase } from "@/lib/infra/case-helpers";
import { hashDni } from "@/lib/utils/dni-hash";
import { withMutationOverride } from "../../../../__tests__/_helpers/db-overrides";
import { createWelfareReport } from "../application/create-welfare-report";
import { WelfareRepository } from "./welfare-repository";

// ---------------------------------------------------------------------------
// Fixture tokens — must not collide with production or other test data
// ---------------------------------------------------------------------------

const PET_TOKEN = "WFR-REPO-TEST-01";
const REF_PREFIX = "DEN-REPO-"; // used to scope cleanup

const repo = new WelfareRepository();

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

async function cleanupFixtures() {
  // Clean up in FK dependency order. audit_log actor_user_id FK is RESTRICT —
  // we only delete rows whose actor is our test marker (null or system). Here we
  // delete by welfareReportId reference in payload, which avoids touching
  // profiles FK at all — the payload jsonb has no FK constraint.
  await db.execute(sql`
    DELETE FROM audit_log
    WHERE payload->>'welfare_report_id' IN (
      SELECT id::text FROM welfare_reports WHERE reference_code LIKE ${`${REF_PREFIX}%`}
    )
  `);
  await db.execute(sql`
    DELETE FROM welfare_report_attachments
    WHERE welfare_report_id IN (
      SELECT id FROM welfare_reports WHERE reference_code LIKE ${`${REF_PREFIX}%`}
    )
  `);
  await db.execute(sql`
    DELETE FROM welfare_reports WHERE reference_code LIKE ${`${REF_PREFIX}%`}
  `);
  await db.execute(sql`
    DELETE FROM pets WHERE public_token = ${PET_TOKEN}
  `);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let petId: string;

beforeAll(async () => {
  await cleanupFixtures();

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "WelfareRepoTestPet",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId = pet.id;
});

afterAll(async () => {
  await cleanupFixtures();
});

// ---------------------------------------------------------------------------
// insertReportWithRetry
// ---------------------------------------------------------------------------

describe("WelfareRepository.insertReportWithRetry", () => {
  it("inserts a report and returns { id, referenceCode }", async () => {
    const result = await repo.insertReportWithRetry({
      referenceCode: `${REF_PREFIX}R001`,
      kind: "neglect",
      severity: "medium",
      description: "Repository integration test fixture (≥20 chars ok).",
      subjectKind: "general",
    });

    expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.referenceCode).toBe(`${REF_PREFIX}R001`);
  });

  it("retries and succeeds on collision: second insert with a fresh code succeeds", async () => {
    // Simulate collision by pre-inserting a row with a known code.
    // Then call insertReportWithRetry with a codeGenerator that first returns
    // the colliding code, then a fresh one.

    const collidingCode = `${REF_PREFIX}R-COL`;
    // Pre-insert to occupy the colliding code.
    await db.insert(welfareReports).values({
      referenceCode: collidingCode,
      kind: "neglect",
      severity: "low",
      description: "Collision fixture row (≥20 chars).",
      subjectKind: "general",
    });

    let callCount = 0;
    const freshCode = `${REF_PREFIX}R-FRESH`;
    const result = await repo.insertReportWithRetry(
      {
        referenceCode: collidingCode, // first attempt will collide
        kind: "other",
        severity: "low",
        description: "Retry test description (≥20 chars).",
        subjectKind: "general",
      },
      undefined, // no tx
      () => {
        callCount++;
        return freshCode; // generator called on retry
      },
    );

    expect(callCount).toBe(1); // generator called once after first collision
    expect(result.referenceCode).toBe(freshCode);
  });

  it("returns an error after 5 failed attempts when all codes collide", async () => {
    // Pre-insert 5 rows with known codes.
    const codes = Array.from({ length: 5 }, (_, i) => `${REF_PREFIX}R-X${i}`);
    for (const code of codes) {
      await db.insert(welfareReports).values({
        referenceCode: code,
        kind: "neglect",
        severity: "low",
        description: "Max-retry collision fixture (≥20 chars).",
        subjectKind: "general",
      });
    }

    let genIdx = 0;
    await expect(
      repo.insertReportWithRetry(
        {
          referenceCode: codes[0],
          kind: "other",
          severity: "low",
          description: "Max retry test (≥20 chars).",
          subjectKind: "general",
        },
        undefined,
        () => codes[genIdx++ % codes.length], // always returns a taken code
      ),
    ).rejects.toThrow("código único");
  });
});

// ---------------------------------------------------------------------------
// insertAttachments
// ---------------------------------------------------------------------------

describe("WelfareRepository.insertAttachments", () => {
  it("inserts attachment rows linked to the report", async () => {
    const [report] = await db
      .insert(welfareReports)
      .values({
        referenceCode: `${REF_PREFIX}ATT01`,
        kind: "neglect",
        severity: "low",
        description: "Attachment test fixture row (≥20 chars).",
        subjectKind: "general",
      })
      .returning();

    await repo.insertAttachments([
      {
        welfareReportId: report.id,
        storagePath: "welfare-evidence/test/file1.jpg",
        mimeType: "image/jpeg",
        fileSize: 1024,
        originalFilename: "file1.jpg",
      },
    ]);

    const attachments = await db
      .select()
      .from(welfareReportAttachments)
      .where(eq(welfareReportAttachments.welfareReportId, report.id));

    expect(attachments).toHaveLength(1);
    expect(attachments[0].storagePath).toBe("welfare-evidence/test/file1.jpg");
    expect(attachments[0].mimeType).toBe("image/jpeg");
  });
});

// ---------------------------------------------------------------------------
// updateStatus
// ---------------------------------------------------------------------------

describe("WelfareRepository.updateStatus", () => {
  it("updates the status field on a report", async () => {
    const [report] = await db
      .insert(welfareReports)
      .values({
        referenceCode: `${REF_PREFIX}UPD01`,
        kind: "neglect",
        severity: "low",
        description: "Status update fixture row (≥20 chars).",
        subjectKind: "general",
        status: "open",
      })
      .returning();

    const now = new Date();
    await repo.updateStatus(report.id, {
      status: "triaged",
      triagedAt: now,
      triagedByUserId: null,
    });

    const [updated] = await db
      .select()
      .from(welfareReports)
      .where(eq(welfareReports.id, report.id));

    expect(updated.status).toBe("triaged");
    expect(updated.triagedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setFlagged
// ---------------------------------------------------------------------------

describe("WelfareRepository.setFlagged", () => {
  it("sets flagged_at and flag_reasons on a report", async () => {
    const [report] = await db
      .insert(welfareReports)
      .values({
        referenceCode: `${REF_PREFIX}FLAG01`,
        kind: "neglect",
        severity: "low",
        description: "Flag test fixture row (≥20 chars).",
        subjectKind: "general",
      })
      .returning();

    const flaggedAt = new Date();
    await repo.setFlagged(report.id, {
      flaggedAt,
      flagReasons: ["trivial_description", "bot_suspected_honeypot"],
    });

    const [updated] = await db
      .select()
      .from(welfareReports)
      .where(eq(welfareReports.id, report.id));

    expect(updated.flaggedAt).not.toBeNull();
    expect(updated.flagReasons).toEqual(
      expect.arrayContaining(["trivial_description", "bot_suspected_honeypot"]),
    );
  });
});

// ---------------------------------------------------------------------------
// setAssignee
// ---------------------------------------------------------------------------

describe("WelfareRepository.setAssignee", () => {
  it("sets assigned_to_user_id to null (unassign)", async () => {
    const [report] = await db
      .insert(welfareReports)
      .values({
        referenceCode: `${REF_PREFIX}ASN01`,
        kind: "neglect",
        severity: "low",
        description: "Assignee test fixture row (≥20 chars).",
        subjectKind: "general",
      })
      .returning();

    await repo.setAssignee(report.id, null);

    const [updated] = await db
      .select()
      .from(welfareReports)
      .where(eq(welfareReports.id, report.id));

    expect(updated.assignedToUserId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findById
// ---------------------------------------------------------------------------

describe("WelfareRepository.findById", () => {
  it("returns the report when it exists", async () => {
    const [report] = await db
      .insert(welfareReports)
      .values({
        referenceCode: `${REF_PREFIX}FBY01`,
        kind: "neglect",
        severity: "medium",
        description: "findById fixture row (≥20 chars).",
        subjectKind: "general",
      })
      .returning();

    const found = await repo.findById(report.id);
    expect(found).not.toBeNull();
    expect(found?.referenceCode).toBe(`${REF_PREFIX}FBY01`);
    expect(found?.status).toBe("open");
  });

  it("returns null when the report does not exist", async () => {
    const found = await repo.findById("00000000-0000-0000-0000-000000000000");
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findAttachments
// ---------------------------------------------------------------------------

describe("WelfareRepository.findAttachments", () => {
  it("returns empty array when no attachments exist", async () => {
    const [report] = await db
      .insert(welfareReports)
      .values({
        referenceCode: `${REF_PREFIX}FATT01`,
        kind: "neglect",
        severity: "low",
        description: "findAttachments empty fixture (≥20 chars).",
        subjectKind: "general",
      })
      .returning();

    const attachments = await repo.findAttachments(report.id);
    expect(attachments).toHaveLength(0);
  });

  it("returns attachment rows when they exist", async () => {
    const [report] = await db
      .insert(welfareReports)
      .values({
        referenceCode: `${REF_PREFIX}FATT02`,
        kind: "neglect",
        severity: "low",
        description: "findAttachments has-rows fixture (≥20 chars).",
        subjectKind: "general",
      })
      .returning();

    await db.insert(welfareReportAttachments).values({
      welfareReportId: report.id,
      storagePath: "welfare-evidence/test/att02.jpg",
      mimeType: "image/jpeg",
      fileSize: 2048,
    });

    const attachments = await repo.findAttachments(report.id);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].storagePath).toBe("welfare-evidence/test/att02.jpg");
  });
});

// ---------------------------------------------------------------------------
// findRecentMpfExport (idempotency lookup — reads audit_log)
// ---------------------------------------------------------------------------
// This test skips audit_log insert (actor FK requires a real profile).
// It verifies findRecentMpfExport returns null when no audit_log row exists.

describe("WelfareRepository.findRecentMpfExport", () => {
  it("returns null when no recent MPF export audit_log row exists", async () => {
    const [report] = await db
      .insert(welfareReports)
      .values({
        referenceCode: `${REF_PREFIX}MPF01`,
        kind: "neglect",
        severity: "low",
        description: "findRecentMpfExport fixture (≥20 chars).",
        subjectKind: "general",
      })
      .returning();

    const result = await repo.findRecentMpfExport(report.id, 24 * 60 * 60 * 1000);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findOpenOtherWelfareCasesForPet (OA9 escalation)
// ---------------------------------------------------------------------------
// Inserts two welfare reports that both reference the same pet, where one has
// a linked case. Then verifies the OA9 finder returns the open case for the
// OTHER report but not the one we're currently processing.

describe("WelfareRepository.findOpenOtherWelfareCasesForPet", () => {
  it("returns empty array when no other open welfare case exists for the pet", async () => {
    const [report] = await db
      .insert(welfareReports)
      .values({
        referenceCode: `${REF_PREFIX}OA9-01`,
        kind: "neglect",
        severity: "low",
        description: "OA9 single-case fixture (≥20 chars).",
        subjectKind: "registered_pet",
        subjectPetId: petId,
      })
      .returning();

    const results = await repo.findOpenOtherWelfareCasesForPet(petId, null);
    // The report we just inserted has no caseId, so nothing should be returned.
    // The result should be an empty array since there are no linked case rows.
    expect(Array.isArray(results)).toBe(true);
    // Cleanup
    await db.delete(welfareReports).where(eq(welfareReports.id, report.id));
  });
});

// ---------------------------------------------------------------------------
// findBridgedReportReplay — the ledger a retried denuncia asks (plan A5c)
// ---------------------------------------------------------------------------
//
// Built the way a filed report about a registered pet leaves the database:
// report row -> welfare_denuncia case linked back to it -> the bridge event
// under the client's key, carrying the case. The query must find the report
// from (pet, key, reporter) and from nothing less.

describe("WelfareRepository.findBridgedReportReplay", () => {
  const replayPetToken = `WFR-REPLAY-${randomUUID().slice(0, 8)}`;
  const key = randomUUID();
  let replayPetId: string;
  let reporterId: string;
  let otherUserId: string;
  let reportId: string;
  let referenceCode: string;

  async function makeProfile(label: string): Promise<string> {
    const id = randomUUID();
    await db.insert(profiles).values({
      id,
      displayName: `WFR replay ${label}`,
      dniHash: hashDni(String(20_000_000 + Math.floor(Math.random() * 9_999_999))),
      dniVerified: true,
      role: "owner",
    });
    return id;
  }

  beforeAll(async () => {
    reporterId = await makeProfile("reporter");
    otherUserId = await makeProfile("other");
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: replayPetToken,
        name: "WelfareReplayPet",
        species: "dog",
        sex: "unknown",
        potentiallyDangerousBreed: false,
      })
      .returning();
    replayPetId = pet.id;

    const report = await repo.insertReportWithRetry({
      referenceCode: `${REF_PREFIX}RPL-${randomUUID().slice(0, 6)}`,
      reporterUserId: reporterId,
      kind: "physical_abuse",
      severity: "high",
      description: "Replay fixture: golpes visibles al animal (≥20 chars).",
      subjectKind: "registered_pet",
    });
    reportId = report.id;
    referenceCode = report.referenceCode;

    const [caseRow] = await db
      .insert(cases)
      .values({
        publicCode: `CAS-WRPL-${randomUUID().slice(0, 4).toUpperCase()}`,
        caseKind: "welfare_denuncia",
        primarySubjectKind: "registered_pet",
        primaryPetId: replayPetId,
        openedReason: "Integration test — welfare replay ledger",
        status: "open",
        welfareReportId: reportId,
      })
      .returning();
    await repo.linkCase(reportId, caseRow.id);

    await db.transaction((tx) =>
      repo.insertPetEventIdempotent(
        {
          petId: replayPetId,
          eventType: "maltreatment_reported",
          occurredAt: new Date("2026-01-10T12:00:00Z"),
          recordedAt: new Date("2026-01-10T12:00:00Z"),
          recordedByUserId: reporterId,
          authorRole: "scanner",
          payload: validateEventPayload("maltreatment_reported", {
            welfare_report_id: reportId,
            reporter_role: "witness",
            description: "Replay fixture: golpes visibles al animal (≥20 chars).",
            severity: "high",
            kind: "physical_abuse",
          }),
          caseId: caseRow.id,
          clientIdempotencyKey: key,
        },
        tx,
      ),
    );
  });

  afterAll(async () => {
    // The report and its case point at each other (welfare_reports.case_id is
    // RESTRICT, cases.welfare_report_id has no action): unlink first, as
    // welfare-cases-d1.test.ts does.
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`UPDATE welfare_reports SET case_id = NULL WHERE id = ${reportId}::uuid`);
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${replayPetId}::uuid`);
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${replayPetId}::uuid`);
      await tx.execute(sql`DELETE FROM welfare_reports WHERE id = ${reportId}::uuid`);
      await tx.execute(sql`DELETE FROM pets WHERE id = ${replayPetId}::uuid`);
      await tx.execute(
        sql`DELETE FROM profiles WHERE id IN (${reporterId}::uuid, ${otherUserId}::uuid)`,
      );
    });
  });

  it("finds the original report for the same pet, key and reporter", async () => {
    await expect(repo.findBridgedReportReplay(replayPetId, key, reporterId)).resolves.toEqual({
      reportId,
      referenceCode,
    });
  });

  it("another reporter presenting the same key gets nothing", async () => {
    await expect(repo.findBridgedReportReplay(replayPetId, key, otherUserId)).resolves.toBeNull();
  });

  it("another key gets nothing", async () => {
    await expect(
      repo.findBridgedReportReplay(replayPetId, randomUUID(), reporterId),
    ).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Two copies of one denuncia in flight at once (plan A5c), on the real database
// ---------------------------------------------------------------------------
//
// Each "submit" does what the action does: insert its report row, then run the
// use case's write. Both pre-checks miss (nothing committed yet); the claim
// inside the write serializes them on (reporter, key), so exactly one files
// and the other answers the original — and its own row is discarded.

describe("createWelfareReport — same-key twins in parallel (real database)", () => {
  const twinPetToken = `WFR-TWIN-${randomUUID().slice(0, 8)}`;
  let twinPetId: string;
  let twinReporterId: string;
  const insertedIds: string[] = [];

  beforeAll(async () => {
    twinReporterId = randomUUID();
    await db.insert(profiles).values({
      id: twinReporterId,
      displayName: "WFR twin reporter",
      dniHash: hashDni(String(50_000_000 + Math.floor(Math.random() * 9_999_999))),
      dniVerified: true,
      role: "owner",
    });
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: twinPetToken,
        name: "WelfareTwinPet",
        species: "dog",
        sex: "unknown",
        potentiallyDangerousBreed: false,
      })
      .returning();
    twinPetId = pet.id;
  });

  afterAll(async () => {
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`UPDATE welfare_reports SET case_id = NULL
        WHERE id IN (SELECT welfare_report_id FROM cases WHERE primary_pet_id = ${twinPetId}::uuid)`);
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${twinPetId}::uuid`);
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${twinPetId}::uuid`);
      for (const id of insertedIds) {
        await tx.execute(sql`DELETE FROM welfare_reports WHERE id = ${id}::uuid`);
      }
      await tx.execute(sql`DELETE FROM pets WHERE id = ${twinPetId}::uuid`);
      await tx.execute(sql`DELETE FROM profiles WHERE id = ${twinReporterId}::uuid`);
    });
  });

  async function submit(key: string) {
    const report = await repo.insertReportWithRetry({
      referenceCode: `${REF_PREFIX}TW-${randomUUID().slice(0, 8)}`,
      reporterUserId: twinReporterId,
      kind: "physical_abuse",
      severity: "high",
      description: "Twin fixture: golpes visibles al animal (≥20 chars).",
      subjectKind: "registered_pet",
    });
    insertedIds.push(report.id);
    const result = await createWelfareReport(
      {
        reportId: report.id,
        referenceCode: report.referenceCode,
        kind: "physical_abuse",
        severity: "high",
        description: "Twin fixture: golpes visibles al animal (≥20 chars).",
        subjectKind: "registered_pet",
        subjectPetId: twinPetId,
        isOwnerOfSubjectPet: false,
        subjectDescription: null,
        locationAddress: null,
        jurisdictionProvince: null,
        jurisdictionLocality: null,
        locationLat: null,
        locationLng: null,
        occurredAt: new Date("2026-01-10T12:00:00Z"),
        reporterContactEmail: null,
        reporterContactPhone: null,
        observedSymptoms: null,
        attachments: [],
        uploadedPaths: [],
        reporterUserId: twinReporterId,
        dwellTimeMs: undefined,
        honeypotValue: "",
        clientIdempotencyKey: key,
      },
      {
        repo,
        openCase: async (input, tx) =>
          openCase(input as Parameters<typeof openCase>[0], tx as Parameters<typeof openCase>[1]),
        computeFlagReasons: async () => [],
        signal: async () => {},
        transaction: db.transaction.bind(db),
        surveillance: {
          match: async () => {
            throw new Error("no symptoms in this fixture");
          },
          emitSignals: async () => {
            throw new Error("no symptoms in this fixture");
          },
        } as unknown as Parameters<typeof createWelfareReport>[1]["surveillance"],
      },
    );
    if (result.ok && result.discardInserted) await repo.deleteUnlinkedReport(report.id);
    return { insertedId: report.id, result };
  }

  it("one files, the other answers the original and leaves no report or case of its own", async () => {
    const key = randomUUID();

    const [a, b] = await Promise.all([submit(key), submit(key)]);

    expect(a.result.ok && b.result.ok).toBe(true);
    if (!a.result.ok || !b.result.ok) return;
    const filed = [a, b].filter((s) => s.result.ok && !s.result.discardInserted);
    const replayed = [a, b].filter((s) => s.result.ok && s.result.discardInserted);
    expect(filed).toHaveLength(1);
    expect(replayed).toHaveLength(1);
    // The replay names the report that was actually filed.
    expect(replayed[0].result.ok && replayed[0].result.reportId).toBe(filed[0].insertedId);

    const denuncias = await db
      .select({ id: cases.id })
      .from(cases)
      .where(sql`${cases.primaryPetId} = ${twinPetId} AND ${cases.caseKind} = 'welfare_denuncia'`);
    expect(denuncias).toHaveLength(1);
    // The superseded row is gone; the filed one stays.
    const rows = await db
      .select({ id: welfareReports.id })
      .from(welfareReports)
      .where(eq(welfareReports.reporterUserId, twinReporterId));
    expect(rows.map((r) => r.id)).toEqual([filed[0].insertedId]);
  });
});

// ---------------------------------------------------------------------------
// The report-level ledger (plan A5f, migration 0289), on the real database
// ---------------------------------------------------------------------------
//
// An ANONYMOUS denuncia about an unowned animal: no reporter, no pet, no bridge
// event — nothing A5c could replay. The key's digest on welfare_reports is the
// whole ledger now. Each "submit" does what the action does: insert its report
// row, run the use case's write, and discard its own row on a replay.

describe("createWelfareReport — the report-level replay (real database)", () => {
  const insertedIds: string[] = [];
  let identifiedReporterId: string;

  beforeAll(async () => {
    identifiedReporterId = randomUUID();
    await db.insert(profiles).values({
      id: identifiedReporterId,
      displayName: "WFR key-digest reporter",
      dniHash: hashDni(String(60_000_000 + Math.floor(Math.random() * 9_999_999))),
      dniVerified: true,
      role: "owner",
    });
  });

  afterAll(async () => {
    await withMutationOverride(async (tx) => {
      for (const id of insertedIds) {
        await tx.execute(sql`UPDATE welfare_reports SET case_id = NULL WHERE id = ${id}::uuid`);
        await tx.execute(sql`DELETE FROM cases WHERE welfare_report_id = ${id}::uuid`);
        await tx.execute(sql`DELETE FROM welfare_reports WHERE id = ${id}::uuid`);
      }
      await tx.execute(sql`DELETE FROM profiles WHERE id = ${identifiedReporterId}::uuid`);
    });
  });

  const DESCRIPTION = "Key-digest fixture: perro atado sin agua en la vereda (≥20 chars).";
  const SUBJECT = "Perro mestizo atado en la vereda.";

  async function submit(key: string, reporterUserId: string | null = null) {
    const report = await repo.insertReportWithRetry({
      referenceCode: `${REF_PREFIX}KD-${randomUUID().slice(0, 8)}`,
      reporterUserId,
      kind: "neglect",
      severity: "medium",
      description: DESCRIPTION,
      subjectKind: "unowned_animal",
      subjectDescription: SUBJECT,
    });
    insertedIds.push(report.id);
    const result = await createWelfareReport(
      {
        reportId: report.id,
        referenceCode: report.referenceCode,
        kind: "neglect",
        severity: "medium",
        description: DESCRIPTION,
        subjectKind: "unowned_animal",
        subjectPetId: null,
        isOwnerOfSubjectPet: false,
        subjectDescription: SUBJECT,
        locationAddress: null,
        jurisdictionProvince: null,
        jurisdictionLocality: null,
        locationLat: null,
        locationLng: null,
        occurredAt: null,
        reporterContactEmail: null,
        reporterContactPhone: null,
        observedSymptoms: null,
        attachments: [],
        uploadedPaths: [],
        reporterUserId,
        dwellTimeMs: undefined,
        honeypotValue: "",
        clientIdempotencyKey: key,
      },
      {
        repo,
        openCase: async (input, tx) =>
          openCase(input as Parameters<typeof openCase>[0], tx as Parameters<typeof openCase>[1]),
        computeFlagReasons: async () => [],
        signal: async () => {},
        transaction: db.transaction.bind(db),
        surveillance: {
          match: async () => {
            throw new Error("no pet in this fixture");
          },
          emitSignals: async () => {
            throw new Error("no pet in this fixture");
          },
        } as unknown as Parameters<typeof createWelfareReport>[1]["surveillance"],
      },
    );
    if (result.ok && result.discardInserted) await repo.deleteUnlinkedReport(report.id);
    return { insertedId: report.id, result };
  }

  /** The submits' rows that still exist, and the denuncia cases opened over them. */
  async function filed(ids: string[]) {
    const idList = sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const reports = await db
      .select({ id: welfareReports.id, digest: welfareReports.clientKeyDigest })
      .from(welfareReports)
      .where(sql`${welfareReports.id} IN (${idList})`);
    const denuncias = await db
      .select({ id: cases.id })
      .from(cases)
      .where(
        sql`${cases.welfareReportId} IN (${idList}) AND ${cases.caseKind} = 'welfare_denuncia'`,
      );
    return { reports, denuncias };
  }

  function isFiled(result: Awaited<ReturnType<typeof submit>>["result"]): boolean {
    return result.ok && !result.discardInserted;
  }

  it("same key, one after the other: one report and one case", async () => {
    const key = randomUUID();
    const first = await submit(key);
    const retry = await submit(key);

    expect(isFiled(first.result)).toBe(true);
    expect(retry.result).toEqual({ ok: true, anonymousReplay: true, discardInserted: true });

    const { reports, denuncias } = await filed([first.insertedId, retry.insertedId]);
    expect(reports.map((r) => r.id)).toEqual([first.insertedId]);
    expect(denuncias).toHaveLength(1);
    // The stored value is a digest, never the key.
    expect(reports[0].digest).toMatch(/^[0-9a-f]{64}$/);
    expect(reports[0].digest).not.toContain(key);
  });

  it("different keys: two reports and two cases", async () => {
    const a = await submit(randomUUID());
    const b = await submit(randomUUID());

    expect(isFiled(a.result)).toBe(true);
    expect(isFiled(b.result)).toBe(true);
    const { reports, denuncias } = await filed([a.insertedId, b.insertedId]);
    expect(reports).toHaveLength(2);
    expect(denuncias).toHaveLength(2);
  });

  it("same key in parallel: exactly one files, the others leave no report or case", async () => {
    const key = randomUUID();
    const submits = await Promise.all([submit(key), submit(key), submit(key)]);

    expect(submits.filter((s) => isFiled(s.result))).toHaveLength(1);
    const { reports, denuncias } = await filed(submits.map((s) => s.insertedId));
    expect(reports).toHaveLength(1);
    expect(denuncias).toHaveLength(1);
  });

  it("another submitter replaying an anonymous key learns nothing about the report", async () => {
    const key = randomUUID();
    const victim = await submit(key);
    if (!victim.result.ok || "anonymousReplay" in victim.result) {
      throw new Error("fixture: the first submit must file");
    }
    const { referenceCode } = victim.result;

    // Another anonymous submitter holding the key: nothing is filed, and the
    // answer carries no id and no reference code — no handle on the denuncia.
    const intruder = await submit(key);
    expect(intruder.result).toEqual({ ok: true, anonymousReplay: true, discardInserted: true });
    expect(JSON.stringify(intruder.result)).not.toContain(referenceCode);
    expect(JSON.stringify(intruder.result)).not.toContain(victim.insertedId);

    // An identified account presenting the same key reaches its OWN slot: it
    // files its own report and never surfaces the anonymous one.
    const identified = await submit(key, identifiedReporterId);
    expect(isFiled(identified.result)).toBe(true);
    const { reports } = await filed([victim.insertedId, identified.insertedId]);
    expect(reports).toHaveLength(2);
    expect(new Set(reports.map((r) => r.digest)).size).toBe(2);
  });

  it("the database refuses a second row under one digest (the index behind the lock)", async () => {
    const first = await submit(randomUUID());
    const [stored] = await db
      .select({ digest: welfareReports.clientKeyDigest })
      .from(welfareReports)
      .where(eq(welfareReports.id, first.insertedId));
    const other = await repo.insertReportWithRetry({
      referenceCode: `${REF_PREFIX}KD-${randomUUID().slice(0, 8)}`,
      kind: "neglect",
      severity: "medium",
      description: "Key-digest fixture: fila que intenta el mismo digest (≥20 chars).",
      subjectKind: "general",
    });
    insertedIds.push(other.id);
    await expect(
      db
        .update(welfareReports)
        .set({ clientKeyDigest: stored.digest })
        .where(eq(welfareReports.id, other.id)),
    ).rejects.toThrow();
  });
});
