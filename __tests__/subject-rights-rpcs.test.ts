// Integration tests for the subject-rights RPCs (compliance handoff PR 1,
// Ley 25.326 arts. 14 + 16).
//
// Covers:
//  1. export_subject_data — self call returns JSON with profile + pets +
//     identifications + pet_events, and writes an audit_log row.
//  2. erase_subject_data — soft-deletes the profile, hashes PII, marks
//     owned pets deleted, writes an audit_log row.
//  3. authorization — a different user cannot call either RPC for someone
//     else's user_id (NON-admin caller raises 'forbidden').
//  4. ARCH-H (migration 0080): audit row survives actor hard-delete with NULL
//     actor_user_id; admin view batch name-lookup handles NULL actor gracefully.

import { createClient } from "@supabase/supabase-js";
import { and, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { completeIdentityAction } from "@/app/actions/auth";
import {
  auditLog,
  caseEvents,
  cases,
  custodyDisputeParties,
  custodyDisputes,
  db,
  notificationDeadLetter,
  notifications,
  orgContactMessages,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  petTransfers,
  pets,
  profiles,
  pushSubscriptions,
  welfareReports,
} from "@/db";
import { pgErrorCode } from "@/lib/infra/db-errors";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { LEGAL_VERSION } from "@/lib/reference/legal-version";
import { setAuditMutationGucs, withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

// Mock next/navigation redirect so completeIdentityAction doesn't throw NEXT_REDIRECT.
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

// Mock the Supabase server client so completeIdentityAction can resolve a user
// without a real Next.js request context. The mock is swapped per-test via
// setMockUserId() before tests that exercise the action end-to-end.
let _mockUserId: string | null = null;
function setMockUserId(id: string | null) {
  _mockUserId = id;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: _mockUserId ? { id: _mockUserId } : null },
      })),
    },
  })),
}));

// We call the RPCs via raw SQL (drizzle/postgres-js) instead of the supabase
// client. PostgREST has a schema cache that doesn't always pick up new
// functions added by post-startup migrations (PGRST202 in CI). Drizzle hits
// the DB directly so cache freshness is irrelevant. The auth.uid() guard
// inside the RPC is exercised by setting `request.jwt.claims` in the
// session, which is what PostgREST normally does.

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

const OWNER_EMAIL = "sr-owner@dim-test.local";
const OTHER_EMAIL = "sr-other@dim-test.local";
const PASS = "SubjRights_2026!";

const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

async function callRpcAs<T>(
  callerUserId: string | null,
  fnSql: ReturnType<typeof sql>,
): Promise<{ data: T | null; error: { code?: string; message: string } | null }> {
  // set_config(..., true) is transaction-scoped, and the postgres-js pool
  // may pick a different connection per execute() call. Wrap the setup +
  // RPC in one transaction so auth.uid() sees the spoofed claim.
  try {
    const result = await db.transaction(async (tx) => {
      const claims = callerUserId ? JSON.stringify({ sub: callerUserId }) : "";
      await tx.execute(sql`SELECT set_config('request.jwt.claims', ${claims}, true)`);
      const rows = (await tx.execute(fnSql)) as unknown as Array<Record<string, unknown>>;
      return rows[0] ? (Object.values(rows[0])[0] as T) : null;
    });
    return { data: result, error: null };
  } catch (err) {
    // drizzle 0.45 wraps the pg error; pgErrorCode walks the `.cause` chain to
    // the real SQLSTATE. Keep the message from the wrapper for diagnostics.
    const e = err as { message?: string };
    return {
      data: null,
      error: { code: pgErrorCode(err) ?? undefined, message: e.message ?? "unknown" },
    };
  }
}

let ownerUserId: string;
let otherUserId: string;
const createdPetIds: string[] = [];

// V1-2 (fix B + C): rows owned by / addressed to the subject, seeded so the
// extended export returns them and the extended erase scrubs them.
let seededWelfareReportId: string | undefined;
let seededTransferId: string | undefined;
let seededOrgId: string | undefined;
let seededOrgMessageId: string | undefined;
let seededNotificationId: string | undefined;
let seededMembershipId: string | undefined;

function makeReferenceCode(): string {
  const part = () =>
    Math.random()
      .toString(36)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 4)
      .padEnd(4, "X");
  return `DEN-${part()}-${part()}`;
}

// Reuse the auth user across runs. audit_log is append-only with no test
// override and points back to actor_user_id via ON DELETE RESTRICT, so a
// "delete + create fresh" strategy breaks on the second run. Instead we
// look up by email and create only when missing. The profile gets its PII
// reset between runs (re-seed below) so the erase test starts clean.
async function ensureUser(email: string): Promise<string> {
  const { data: list } = await admin.auth.admin.listUsers();
  const found = list?.users.find((u) => u.email === email);
  if (found) return found.id;
  const { data, error } = await createFreshTestUser(admin, {
    email,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`);
  return data.user.id;
}

async function resetProfilePIIToFresh(userId: string, displayName: string) {
  await db
    .update(profiles)
    .set({
      displayName,
      phone: "+5491100000000",
      // Wave 5 Item 25a: no plaintext DNI column.
      dniHash: null,
      dniLast4: null,
      // Seed the extended PII columns so the erase test can assert they are
      // nulled (V1-2 fix B). preferred_vet_* is third-party PII, avatar_url a
      // face photo, matricula_* professional-license PII.
      preferredVetName: "Dr. Vet Fixture",
      preferredVetPhone: "+5491155550000",
      // A PATH now, not a URL — migration 0219. The column name stayed
      // `avatar_url` because the RPCs name it; the contents did not.
      avatarStoragePath: `${"00000000-0000-0000-0000-000000000000"}/1700000000000.jpg`,
      matriculaNumber: null,
      matriculaJurisdiccion: null,
      // Seed consent so a fresh re-run starts from a known state. The signup
      // consent test asserts these get written by completeIdentityAction; here
      // we pre-clear/reset for the erase + export suites.
      tosAcceptedAt: null,
      tosVersion: null,
      deletedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(profiles.id, userId));
}

beforeAll(async () => {
  ownerUserId = await ensureUser(OWNER_EMAIL);
  otherUserId = await ensureUser(OTHER_EMAIL);
  await resetProfilePIIToFresh(ownerUserId, "SR Test Owner");
  await resetProfilePIIToFresh(otherUserId, "SR Test Other");

  // One pet owned by ownerUserId, for the export assertion to be non-empty.
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: generatePublicToken(),
      name: "SRTestPet",
      species: "dog",
      sex: "male",
      potentiallyDangerousBreed: false,
    })
    .returning();
  createdPetIds.push(pet.id);
  await db.insert(ownerships).values({
    petId: pet.id,
    ownerUserId,
    role: "owner",
  });

  // --- V1-2 export/erase fixtures: data the subject filed or is party to ----

  // Welfare report FILED BY the subject (reporter contact + self-identifying
  // description). Export must return it; erase must scrub it.
  const [welfare] = await db
    .insert(welfareReports)
    .values({
      referenceCode: makeReferenceCode(),
      reporterUserId: ownerUserId,
      reporterContactEmail: "reporter-contact@dim-test.local",
      reporterContactPhone: "+5491166660000",
      kind: "neglect",
      severity: "high",
      description: "Mi nombre es SR Test Owner y vi un animal en mal estado en mi cuadra.",
      subjectKind: "unowned_animal",
      subjectDescription: "Perro mestizo, atado sin agua.",
      // Free-text location address — the reporter may have written their own
      // home address here. Erase must null it (fix 1).
      locationAddress: "Av. Siempreviva 742, Springfield",
    })
    .returning({ id: welfareReports.id });
  seededWelfareReportId = welfare.id;

  // Pet transfer INITIATED BY the subject (from_owner_id). Export must return
  // it; erase must null to_owner_email.
  const [transfer] = await db
    .insert(petTransfers)
    .values({
      publicToken: generatePublicToken(),
      petId: pet.id,
      fromOwnerId: ownerUserId,
      toOwnerEmail: "recipient@dim-test.local",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: petTransfers.id });
  seededTransferId = transfer.id;

  // Org + contact message SENT BY the subject (inquirer_email = OWNER_EMAIL).
  // Export does not include org messages, but erase must scrub the email.
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: `SR-TEST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      legalName: "SR Test Org",
      displayName: "SR Test Org",
      orgType: "shelter",
      email: `sr-test-org-${Math.random().toString(36).slice(2, 8)}@dim-test.local`,
    })
    .returning({ id: organizations.id });
  seededOrgId = org.id;

  const [orgMessage] = await db
    .insert(orgContactMessages)
    .values({
      organizationId: org.id,
      inquirerName: "SR Test Owner",
      inquirerEmail: OWNER_EMAIL,
      message: "Hola, quisiera ofrecerme como voluntario.",
    })
    .returning({ id: orgContactMessages.id });
  seededOrgMessageId = orgMessage.id;

  // Notification ADDRESSED TO the subject. Export must return it.
  const [notification] = await db
    .insert(notifications)
    .values({
      userId: ownerUserId,
      notificationType: "test_subject_rights",
      title: "Notificación de prueba",
      body: "Cuerpo de la notificación.",
    })
    .returning({ id: notifications.id });
  seededNotificationId = notification.id;

  // Organization membership HELD BY the subject. Export must return it.
  const [membership] = await db
    .insert(organizationMemberships)
    .values({
      organizationId: org.id,
      userId: ownerUserId,
      role: "member",
    })
    .returning({ id: organizationMemberships.id });
  seededMembershipId = membership.id;
});

afterAll(async () => {
  // V1-2 seeded relations. Delete before the pet (pet_transfers cascades on
  // pet delete, but we remove explicitly to keep cleanup deterministic) and
  // before the org (org_contact_messages + memberships cascade on org delete).
  if (seededWelfareReportId) {
    await db.delete(welfareReports).where(eq(welfareReports.id, seededWelfareReportId));
  }
  if (seededTransferId) {
    await db.delete(petTransfers).where(eq(petTransfers.id, seededTransferId));
  }
  if (seededNotificationId) {
    await db.delete(notifications).where(eq(notifications.id, seededNotificationId));
  }
  if (seededMembershipId) {
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.id, seededMembershipId));
  }
  if (seededOrgMessageId) {
    await db.delete(orgContactMessages).where(eq(orgContactMessages.id, seededOrgMessageId));
  }
  if (seededOrgId) {
    await db.delete(organizations).where(eq(organizations.id, seededOrgId));
  }

  // Pet rows: append-only via trigger, need the override.
  // audit_log entries leak by design (append-only); test users leak too.
  // Next run reuses them via ensureUser.
  await withMutationOverride(async (tx) => {
    for (const id of createdPetIds) {
      await tx.delete(ownerships).where(eq(ownerships.petId, id));
      await tx.delete(pets).where(eq(pets.id, id));
    }
  });
});

// ---------------------------------------------------------------------------

describe("export_subject_data RPC", () => {
  it("returns the owner's profile + pets + identifications + events when called by themselves", async () => {
    const { data, error } = await callRpcAs<Record<string, unknown>>(
      ownerUserId,
      sql`SELECT public.export_subject_data(${ownerUserId}::uuid) AS result`,
    );

    expect(error).toBeNull();
    expect(data).toBeDefined();
    const payload = data as Record<string, unknown>;
    expect(payload.subject_user_id).toBe(ownerUserId);
    expect(payload.exported_under).toBe("Ley 25.326 art. 14");
    expect(payload.profile).toBeDefined();
    expect(Array.isArray(payload.pets)).toBe(true);
    expect((payload.pets as unknown[]).length).toBeGreaterThan(0);

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "subject_data_exported"));
    expect(audits.some((a) => a.targetUserId === ownerUserId)).toBe(true);
  });

  it("refuses to export another user's data for a non-admin caller", async () => {
    const { error } = await callRpcAs(
      otherUserId,
      sql`SELECT public.export_subject_data(${ownerUserId}::uuid) AS result`,
    );
    expect(error).not.toBeNull();
    // SQLSTATE 42501 = insufficient_privilege (raised by the RPC).
    expect(error?.code).toBe("42501");
  });

  // V1-2 fix C: export now includes every relation the subject is party to.
  // The per-section depth lives in the file that owns each section
  // (pet_tags → subject-rights-pet-tags.test.ts; the 0205 four →
  // subject-rights-caretaker-foster-contact.test.ts). What THIS test owns is
  // the export's top-level shape: the version stamp and the set of keys.
  it("includes welfare reports, disputes, transfers, notifications, memberships and audit rows (schema v5)", async () => {
    const { data, error } = await callRpcAs<Record<string, unknown>>(
      ownerUserId,
      sql`SELECT public.export_subject_data(${ownerUserId}::uuid) AS result`,
    );
    expect(error).toBeNull();
    const payload = data as Record<string, unknown>;

    // 3 → 4 in migration 0205 (pet_caretaker_grants, foster_volunteers,
    // org_contact_messages and push_subscriptions joined the projection);
    // 4 → 5 in migration 0208 (operator_feed_watermarks, physical_tag_interest
    // and organization_invitations joined it too).
    expect(payload.schema_version).toBe(5);

    // The three sections that BUY the 5. Without them the number above is a
    // decoration: it would keep passing over an export that dropped them.
    //
    // What this pins and what it does NOT: it proves the key is built into the
    // returned object under the name the subject-rights fence declares, and that
    // it is an array. It does NOT prove the section is populated correctly —
    // this test seeds no rows into any of the three, so an empty array satisfies
    // it, and that is the honest limit here. Contents are the 0208 lane's own
    // tests; that the RPC body reaches each table at all is
    // scripts/check-subject-rights-coverage.ts, which — by its own header —
    // proves MENTION and nothing more: it greps the live function TEXT for
    // `public.<table>`. So it cannot see a section that is SELECTed from the
    // right table and then returned under the wrong key. Measured on a mutant
    // that renames the returned key to `operator_feed_watermarks_typo`: the
    // `FROM public.operator_feed_watermarks` the fence greps for is still there,
    // and only this loop goes red. Closing that gap is the point of the loop.
    for (const section of [
      "operator_feed_watermarks",
      "physical_tag_interest",
      "organization_invitations",
    ]) {
      expect(payload, `export_subject_data must return a '${section}' section`).toHaveProperty(
        section,
      );
      expect(Array.isArray(payload[section]), `'${section}' must be an array`).toBe(true);
    }

    const welfare = payload.welfare_reports_filed as Array<Record<string, unknown>>;
    expect(Array.isArray(welfare)).toBe(true);
    expect(welfare.some((w) => w.id === seededWelfareReportId)).toBe(true);

    const transfers = payload.pet_transfers as Array<Record<string, unknown>>;
    expect(Array.isArray(transfers)).toBe(true);
    expect(transfers.some((t) => t.id === seededTransferId)).toBe(true);

    const notifs = payload.notifications as Array<Record<string, unknown>>;
    expect(Array.isArray(notifs)).toBe(true);
    expect(notifs.some((n) => n.id === seededNotificationId)).toBe(true);

    const memberships = payload.organization_memberships as Array<Record<string, unknown>>;
    expect(Array.isArray(memberships)).toBe(true);
    expect(memberships.some((m) => m.id === seededMembershipId)).toBe(true);

    // custody_disputes + audit_log are present as arrays even when empty for
    // this subject (the prior export call already wrote a subject_data_exported
    // audit row, so audit_log is non-empty).
    expect(Array.isArray(payload.custody_disputes)).toBe(true);
    const auditRows = payload.audit_log as Array<Record<string, unknown>>;
    expect(Array.isArray(auditRows)).toBe(true);
    expect(auditRows.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe("erase_subject_data RPC", () => {
  it("soft-deletes the profile, hashes PII, and writes an audit row when called by the subject", async () => {
    const { error } = await callRpcAs(
      ownerUserId,
      sql`SELECT public.erase_subject_data(${ownerUserId}::uuid, 'test cleanup'::text) AS result`,
    );
    expect(error).toBeNull();

    const [row] = await db
      .select({
        displayName: profiles.displayName,
        phone: profiles.phone,
        // Wave 5 Item 25a: check hash is cleared, not plaintext DNI.
        dniHash: profiles.dniHash,
        deletedAt: profiles.deletedAt,
        // V1-2 fix B: extended PII columns.
        preferredVetName: profiles.preferredVetName,
        preferredVetPhone: profiles.preferredVetPhone,
        avatarStoragePath: profiles.avatarStoragePath,
        matriculaNumber: profiles.matriculaNumber,
        matriculaJurisdiccion: profiles.matriculaJurisdiccion,
      })
      .from(profiles)
      .where(eq(profiles.id, ownerUserId));
    expect(row.deletedAt).not.toBeNull();
    expect(row.displayName).toMatch(/^erased:/);
    expect(row.phone).toBeNull();
    expect(row.dniHash).toBeNull();
    // Newly-covered profile PII columns are nulled.
    expect(row.preferredVetName).toBeNull();
    expect(row.preferredVetPhone).toBeNull();
    expect(row.avatarStoragePath).toBeNull();
    expect(row.matriculaNumber).toBeNull();
    expect(row.matriculaJurisdiccion).toBeNull();

    // Owned pet was soft-deleted too.
    const [petRow] = await db
      .select({ deletedAt: pets.deletedAt })
      .from(pets)
      .where(eq(pets.id, createdPetIds[0]));
    expect(petRow.deletedAt).not.toBeNull();

    // V1-2 fix B: welfare report the subject filed — reporter contact + free-text
    // location address cleared; description redacted to the sentinel.
    // subject_description + location_lat/lng are NOT erased (retention exemption).
    if (!seededWelfareReportId) throw new Error("seededWelfareReportId not set");
    const [welfareRow] = await db
      .select({
        reporterContactEmail: welfareReports.reporterContactEmail,
        reporterContactPhone: welfareReports.reporterContactPhone,
        locationAddress: welfareReports.locationAddress,
        description: welfareReports.description,
      })
      .from(welfareReports)
      .where(eq(welfareReports.id, seededWelfareReportId));
    expect(welfareRow.reporterContactEmail).toBeNull();
    expect(welfareRow.reporterContactPhone).toBeNull();
    expect(welfareRow.locationAddress).toBeNull();
    expect(welfareRow.description).toBe("[contenido eliminado a pedido del titular]");

    // V1-2 fix B: pet transfer recipient email scrubbed.
    if (!seededTransferId) throw new Error("seededTransferId not set");
    const [transferRow] = await db
      .select({ toOwnerEmail: petTransfers.toOwnerEmail })
      .from(petTransfers)
      .where(eq(petTransfers.id, seededTransferId));
    expect(transferRow.toOwnerEmail).toBe("erased@invalid.local");

    // V1-2 fix B: org contact message inquirer email scrubbed.
    if (!seededOrgMessageId) throw new Error("seededOrgMessageId not set");
    const [orgMsgRow] = await db
      .select({
        inquirerEmail: orgContactMessages.inquirerEmail,
        inquirerName: orgContactMessages.inquirerName,
      })
      .from(orgContactMessages)
      .where(eq(orgContactMessages.id, seededOrgMessageId));
    expect(orgMsgRow.inquirerEmail).toBe("erased@invalid.local");
    expect(orgMsgRow.inquirerName).toBeNull();

    // Audit entry present with the citation.
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "subject_erasure"));
    const ours = audits.find((a) => a.targetUserId === ownerUserId);
    expect(ours).toBeDefined();
    expect((ours?.payload as Record<string, unknown>).norma).toBe("Ley 25.326 art. 16");

    // Idempotent + safe to re-run: a second erase must not error.
    const { error: secondErr } = await callRpcAs(
      ownerUserId,
      sql`SELECT public.erase_subject_data(${ownerUserId}::uuid, 'test cleanup re-run'::text) AS result`,
    );
    expect(secondErr).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// V1-2 fix B (negative): erase must NOT touch reports the subject did NOT file.
// ---------------------------------------------------------------------------
// Seeds a welfare report where reporter_user_id = otherUserId (NOT the subject
// being erased). Erases ownerUserId. Asserts that the other reporter's contact
// fields and description are unchanged.

describe("erase_subject_data — negative: third-party welfare reports are untouched", () => {
  let thirdPartyReportId: string | undefined;

  beforeAll(async () => {
    // Seed a report filed by otherUserId — ownerUserId is the *reported* party
    // (via subjectKind=unowned_animal; reporter_user_id is otherUserId).
    const [report] = await db
      .insert(welfareReports)
      .values({
        referenceCode: makeReferenceCode(),
        reporterUserId: otherUserId,
        reporterContactEmail: "third-party-reporter@dim-test.local",
        reporterContactPhone: "+5491177770000",
        kind: "physical_abuse",
        severity: "medium",
        description: "Descripción original del tercero denunciante.",
        subjectKind: "unowned_animal",
        subjectDescription: "Perro mestizo, sin collar.",
      })
      .returning({ id: welfareReports.id });
    thirdPartyReportId = report.id;
  });

  afterAll(async () => {
    if (thirdPartyReportId) {
      await db.delete(welfareReports).where(eq(welfareReports.id, thirdPartyReportId));
    }
  });

  it("erasing the subject leaves reporter contact + description on a third-party report intact", async () => {
    // Ensure the subject's profile is in an erasable state (re-seed after the
    // main erase test which already ran beforeAll in the same suite).
    await resetProfilePIIToFresh(ownerUserId, "SR Test Owner Neg");

    // Erase ownerUserId — should only touch rows where reporter_user_id = ownerUserId.
    const { error } = await callRpcAs(
      ownerUserId,
      sql`SELECT public.erase_subject_data(${ownerUserId}::uuid, 'negative test'::text) AS result`,
    );
    expect(error).toBeNull();

    // The third-party report (reporter_user_id = otherUserId) must be untouched.
    if (!thirdPartyReportId) throw new Error("thirdPartyReportId not set");
    const [row] = await db
      .select({
        reporterContactEmail: welfareReports.reporterContactEmail,
        reporterContactPhone: welfareReports.reporterContactPhone,
        description: welfareReports.description,
      })
      .from(welfareReports)
      .where(eq(welfareReports.id, thirdPartyReportId));

    expect(row.reporterContactEmail).toBe("third-party-reporter@dim-test.local");
    expect(row.reporterContactPhone).toBe("+5491177770000");
    expect(row.description).toBe("Descripción original del tercero denunciante.");
  });
});

// ---------------------------------------------------------------------------
// Wave D2 (migration 0129): third-party PII in event payloads is redacted.
// ---------------------------------------------------------------------------
// Finding 27-#3: an incident_reported event carries the victim's identifying
// contact details (victim_contact_name / victim_contact_phone) as free text.
// erase_subject_data must redact those keys for events tied to the erasing
// subject, while leaving sanitary event payloads (vaccination/medical) intact
// for retention. The redaction runs under the append-only override, so each
// redacted row must also emit a pet_events_mutation_override audit row.

describe("erase_subject_data — redacts third-party PII in event payloads (0129)", () => {
  let incidentEventId: string | undefined;
  let sanitaryEventId: string | undefined;

  beforeAll(async () => {
    // Re-seed the subject to an erasable state (prior suites already erased it).
    await resetProfilePIIToFresh(ownerUserId, "SR Test Owner Events");

    const petId = createdPetIds[0];
    if (!petId) throw new Error("createdPetIds[0] not set");

    // Incident report the subject filed on their own pet — carries a THIRD
    // party's (the bite victim's) contact PII.
    const [incident] = await db
      .insert(petEvents)
      .values({
        petId,
        eventType: "incident_reported",
        occurredAt: new Date(),
        recordedByUserId: ownerUserId,
        authorRole: "owner",
        payload: {
          incident_type: "bite_inflicted",
          severity: "moderate",
          injuries_summary: "Herida leve en la mano.",
          victim_kind: "human",
          victim_contact_name: "Vecino Tercero",
          victim_contact_phone: "+5491188889999",
          reporter_role: "owner",
        },
      })
      .returning({ id: petEvents.id });
    incidentEventId = incident.id;

    // Sanitary event on the same pet — must be retained verbatim.
    const [sanitary] = await db
      .insert(petEvents)
      .values({
        petId,
        eventType: "vaccination_administered",
        occurredAt: new Date(),
        recordedByUserId: ownerUserId,
        authorRole: "owner",
        payload: {
          vaccine: "antirrábica",
          lote_biologico: "LOTE-2026-XYZ",
          laboratorio: "Lab Fixture",
        },
      })
      .returning({ id: petEvents.id });
    sanitaryEventId = sanitary.id;
  });

  it("removes victim contact keys from the incident payload but keeps sanitary payloads", async () => {
    const { error } = await callRpcAs(
      ownerUserId,
      sql`SELECT public.erase_subject_data(${ownerUserId}::uuid, 'event pii redaction'::text) AS result`,
    );
    expect(error).toBeNull();

    if (!incidentEventId) throw new Error("incidentEventId not set");
    const [incidentRow] = await db
      .select({ payload: petEvents.payload })
      .from(petEvents)
      .where(eq(petEvents.id, incidentEventId));
    const incidentPayload = incidentRow.payload as Record<string, unknown>;
    // Third-party contact PII gone.
    expect("victim_contact_name" in incidentPayload).toBe(false);
    expect("victim_contact_phone" in incidentPayload).toBe(false);
    // Non-PII incident fields retained.
    expect(incidentPayload.incident_type).toBe("bite_inflicted");
    expect(incidentPayload.severity).toBe("moderate");
    // FLIPPED ON PURPOSE (T3-A2b, PO decision 5A 2026-09-22). 0129 documented
    // injuries_summary as retained; it is the bite VICTIM's health data, a
    // third party's, whoever typed it — so erasure now replaces it with the
    // sentinel. The epidemiology (incident_type, severity, victim_kind, and the
    // victim_age_band derived from the age text) is what survives.
    expect(incidentPayload.injuries_summary).toBe("[dato removido]");
    expect(incidentPayload.victim_kind).toBe("human");

    // Sanitary payload untouched (retention).
    if (!sanitaryEventId) throw new Error("sanitaryEventId not set");
    const [sanitaryRow] = await db
      .select({ payload: petEvents.payload })
      .from(petEvents)
      .where(eq(petEvents.id, sanitaryEventId));
    const sanitaryPayload = sanitaryRow.payload as Record<string, unknown>;
    expect(sanitaryPayload.lote_biologico).toBe("LOTE-2026-XYZ");
    expect(sanitaryPayload.laboratorio).toBe("Lab Fixture");
  });

  it("emits a pet_events_mutation_override audit row for the redacted event", async () => {
    if (!incidentEventId) throw new Error("incidentEventId not set");
    // The pet_event_id predicate belongs in SQL, not in a JS .some() over the
    // whole table. This used to select EVERY override row and filter after the
    // fetch: fine on a fresh database, and a 5-second timeout on a developer
    // machine where seed runs have piled up 1.7 MILLION override rows (each
    // seed clean deletes hundreds of thousands of events through the audited
    // hatch, and every one writes an audit row). Measured 2026-08-01 — this is
    // the intermittent failure that showed up once in a full-suite run and
    // could not be reproduced afterwards, because it depends on how much
    // history the local database has accumulated, not on the code.
    //
    // Same shape as two other defects found the same day: a query that is
    // correct at small scale and wrong past a threshold, because the predicate
    // that discriminates is applied after the rows are fetched instead of by
    // the database.
    const overrides = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "pet_events_mutation_override"),
          sql`${auditLog.payload}->>'pet_event_id' = ${incidentEventId}`,
        ),
      );
    expect(overrides.length).toBeGreaterThan(0);
  });

  it("is idempotent — re-erasing matches no event rows the second time", async () => {
    // The first erase already stripped the keys; a re-run's key-presence guard
    // must match nothing and not error.
    const { error } = await callRpcAs(
      ownerUserId,
      sql`SELECT public.erase_subject_data(${ownerUserId}::uuid, 'event pii redaction rerun'::text) AS result`,
    );
    expect(error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Migration 0159: free-text payload keys redacted on the subject's OWN
// pet_events (cursor privacy P6).
// ---------------------------------------------------------------------------
// Unlike the 0129/0131 victim_contact fix (scoped to incident_reported and
// DELETES the keys), this redaction runs across ANY event_type and REPLACES a
// known set of free-text keys with a sentinel, mirroring the case_events
// pattern. Seeds a status_changed event carrying reason/location_description
// plus a nested lost_description object, and a sanitary vaccination event
// whose unrelated keys must survive untouched.

describe("erase_subject_data — redacts free-text payload keys on own pet_events (0159)", () => {
  let statusChangedEventId: string | undefined;
  let sanitaryEventId: string | undefined;

  beforeAll(async () => {
    await resetProfilePIIToFresh(ownerUserId, "SR Test Owner 0159");

    const petId = createdPetIds[0];
    if (!petId) throw new Error("createdPetIds[0] not set");

    const [statusChanged] = await db
      .insert(petEvents)
      .values({
        petId,
        eventType: "status_changed",
        occurredAt: new Date(),
        recordedByUserId: ownerUserId,
        authorRole: "owner",
        payload: {
          payload_version: 1,
          from_status: "active",
          to_status: "lost",
          reason: "Se escapó por el portón, lo vio mi vecino Juan Pérez.",
          location_description: "Plaza San Martín, cerca de la casa de mi ex Ana Gómez.",
          lost_description: {
            accessories_when_lost: "Collar con chapita con mi teléfono +5491100000000.",
            behavior_notes: "Se esconde cuando lo llama mi hijo Tomás.",
            last_seen_context: "Salió corriendo detrás del auto de mi vecino Carlos.",
          },
        },
      })
      .returning({ id: petEvents.id });
    statusChangedEventId = statusChanged.id;

    const [sanitary] = await db
      .insert(petEvents)
      .values({
        petId,
        eventType: "vaccination_administered",
        occurredAt: new Date(),
        recordedByUserId: ownerUserId,
        authorRole: "owner",
        payload: {
          vaccine: "antirrábica",
          lote_biologico: "LOTE-0159-XYZ",
          laboratorio: "Lab Fixture 0159",
        },
      })
      .returning({ id: petEvents.id });
    sanitaryEventId = sanitary.id;
  });

  it("redacts top-level and nested free-text keys but keeps the event row + non-text fields", async () => {
    const { error } = await callRpcAs(
      ownerUserId,
      sql`SELECT public.erase_subject_data(${ownerUserId}::uuid, 'free text redaction'::text) AS result`,
    );
    expect(error).toBeNull();

    if (!statusChangedEventId) throw new Error("statusChangedEventId not set");
    const [row] = await db
      .select({ payload: petEvents.payload })
      .from(petEvents)
      .where(eq(petEvents.id, statusChangedEventId));
    const payload = row.payload as Record<string, unknown>;

    expect(payload.reason).toBe("[dato removido]");
    expect(payload.location_description).toBe("[dato removido]");
    const lostDescription = payload.lost_description as Record<string, unknown>;
    expect(lostDescription.accessories_when_lost).toBe("[dato removido]");
    expect(lostDescription.behavior_notes).toBe("[dato removido]");
    expect(lostDescription.last_seen_context).toBe("[dato removido]");
    // Structural fields untouched — only free text is redacted.
    expect(payload.from_status).toBe("active");
    expect(payload.to_status).toBe("lost");
    expect(payload.payload_version).toBe(1);

    // Sanitary payload untouched (retention) — no matching free-text keys.
    if (!sanitaryEventId) throw new Error("sanitaryEventId not set");
    const [sanitaryRow] = await db
      .select({ payload: petEvents.payload })
      .from(petEvents)
      .where(eq(petEvents.id, sanitaryEventId));
    const sanitaryPayload = sanitaryRow.payload as Record<string, unknown>;
    expect(sanitaryPayload.lote_biologico).toBe("LOTE-0159-XYZ");
    expect(sanitaryPayload.laboratorio).toBe("Lab Fixture 0159");
  });

  it("emits a pet_events_mutation_override audit row for the redacted event", async () => {
    if (!statusChangedEventId) throw new Error("statusChangedEventId not set");
    // Same fetch-then-filter defect as the sibling assertion above — see the
    // note there for why it only failed on a database with history.
    const overrides = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "pet_events_mutation_override"),
          sql`${auditLog.payload}->>'pet_event_id' = ${statusChangedEventId}`,
        ),
      );
    expect(overrides.length).toBeGreaterThan(0);
  });

  it("is idempotent — re-erasing matches no free-text event rows the second time", async () => {
    const { error } = await callRpcAs(
      ownerUserId,
      sql`SELECT public.erase_subject_data(${ownerUserId}::uuid, 'free text redaction rerun'::text) AS result`,
    );
    expect(error).toBeNull();

    // Values from the first pass remain the sentinel — a second pass is a no-op.
    if (!statusChangedEventId) throw new Error("statusChangedEventId not set");
    const [row] = await db
      .select({ payload: petEvents.payload })
      .from(petEvents)
      .where(eq(petEvents.id, statusChangedEventId));
    const payload = row.payload as Record<string, unknown>;
    expect(payload.reason).toBe("[dato removido]");
  });
});

// ---------------------------------------------------------------------------
// Migration 0130: dispute-party / case_events / notification PII redaction.
// ---------------------------------------------------------------------------
// The subject's own free-text contributions across the remaining PII holders
// (custody_dispute_parties.party_position_summary, case_events reporter_comment
// notes, notifications title/body/cta) must all be scrubbed on erasure. Seeds a
// row in every holder, erases, and asserts nothing identifying remains — while
// a counterparty's dispute-party row is left intact.

describe("erase_subject_data — scrubs dispute/case/notification PII (0130)", () => {
  let disputeId: string | undefined;
  let subjectPartyId: string | undefined;
  let otherPartyId: string | undefined;
  let caseId: string | undefined;
  let caseEventId: string | undefined;
  let notificationId: string | undefined;
  let raisingEventId: string | undefined;

  beforeAll(async () => {
    await resetProfilePIIToFresh(ownerUserId, "SR Test Owner 0130");

    const petId = createdPetIds[0];
    if (!petId) throw new Error("createdPetIds[0] not set");

    // A raising pet_event for the dispute FK.
    const [raising] = await db
      .insert(petEvents)
      .values({
        petId,
        eventType: "custody_dispute_raised",
        occurredAt: new Date(),
        recordedByUserId: ownerUserId,
        authorRole: "owner",
        payload: { raised_by_role: "owner" },
      })
      .returning({ id: petEvents.id });

    const [dispute] = await db
      .insert(custodyDisputes)
      .values({
        publicToken: `DIS-0130-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        petId,
        raisedByUserId: ownerUserId,
        raisedByRole: "owner",
        raisingEventId: raising.id,
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "La Plata",
      })
      .returning({ id: custodyDisputes.id });
    disputeId = dispute.id;
    raisingEventId = raising.id;

    // The subject's own party row — position statement carries their PII.
    const [subjectParty] = await db
      .insert(custodyDisputeParties)
      .values({
        disputeId: dispute.id,
        partyUserId: ownerUserId,
        partyRole: "claimant_owner",
        partyPositionSummary: "Soy SR Test Owner, teléfono +5491100000000, la mascota es mía.",
      })
      .returning({ id: custodyDisputeParties.id });
    subjectPartyId = subjectParty.id;

    // A counterparty party row — MUST survive erasure of the subject.
    const [otherParty] = await db
      .insert(custodyDisputeParties)
      .values({
        disputeId: dispute.id,
        partyUserId: otherUserId,
        partyRole: "current_owner",
        partyPositionSummary: "Posición de la contraparte — no debe borrarse.",
      })
      .returning({ id: custodyDisputeParties.id });
    otherPartyId = otherParty.id;

    // A welfare-denuncia case + reporter_comment authored by the subject.
    const [c] = await db
      .insert(cases)
      .values({
        publicCode: `CAS-0130-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        caseKind: "welfare_denuncia",
        primarySubjectKind: "general",
        status: "open",
        openedReason: "Fixture for 0130 reporter-comment redaction",
      })
      .returning({ id: cases.id });
    caseId = c.id;

    const [ce] = await db
      .insert(caseEvents)
      .values({
        caseId: c.id,
        entryType: "reporter_comment",
        payload: { source: "reporter" },
        notes: "Mi nombre es SR Test Owner y mi teléfono es +5491100000000.",
        recordedByUserId: ownerUserId,
      })
      .returning({ id: caseEvents.id });
    caseEventId = ce.id;

    // A notification addressed to the subject with free-text content + CTA.
    const [n] = await db
      .insert(notifications)
      .values({
        userId: ownerUserId,
        notificationType: "custody_update_0130",
        title: "Novedad sobre Firulais",
        body: "Tu mascota Firulais tiene una actualización.",
        ctaLabel: "Ver",
        ctaUrl: "/mis-mascotas/DIM-SECRET-TOKEN",
      })
      .returning({ id: notifications.id });
    notificationId = n.id;
  });

  afterAll(async () => {
    await withMutationOverride(async (tx) => {
      if (caseEventId) await tx.delete(caseEvents).where(eq(caseEvents.id, caseEventId));
    });
    if (disputeId) {
      await db.delete(custodyDisputeParties).where(eq(custodyDisputeParties.disputeId, disputeId));
      await db.delete(custodyDisputes).where(eq(custodyDisputes.id, disputeId));
    }
    if (caseId) await db.delete(cases).where(eq(cases.id, caseId));
    if (notificationId) await db.delete(notifications).where(eq(notifications.id, notificationId));
    await withMutationOverride(async (tx) => {
      // SCOPED to this suite's own event. It used to delete EVERY
      // custody_dispute_raised row in the database, and
      // custody_disputes.raising_event_id is ON DELETE CASCADE — so it wiped
      // every dispute in the DB, including the demo dispute on
      // DIM-BRUNO-DEMO, while leaving pets.in_custody_dispute = true and the
      // open case behind. That orphan trio is what made
      // __tests__/pet-cache-rederivation.test.ts's fitness sweep fail on every
      // full-suite run, and with it the project's "pnpm test green" Definition
      // of Done (traced 2026-07-25 with a DB trigger on the cascade path).
      if (raisingEventId) {
        await tx.delete(petEvents).where(eq(petEvents.id, raisingEventId));
      }
    });
  });

  it("nulls the subject's dispute position, redacts their case comment + notifications, keeps the counterparty", async () => {
    const { error } = await callRpcAs(
      ownerUserId,
      sql`SELECT public.erase_subject_data(${ownerUserId}::uuid, '0130 redaction'::text) AS result`,
    );
    expect(error).toBeNull();

    // Subject's own dispute-party position statement → nulled.
    if (!subjectPartyId) throw new Error("subjectPartyId not set");
    const [subjRow] = await db
      .select({ summary: custodyDisputeParties.partyPositionSummary })
      .from(custodyDisputeParties)
      .where(eq(custodyDisputeParties.id, subjectPartyId));
    expect(subjRow.summary).toBeNull();

    // Counterparty's position statement → untouched.
    if (!otherPartyId) throw new Error("otherPartyId not set");
    const [otherRow] = await db
      .select({ summary: custodyDisputeParties.partyPositionSummary })
      .from(custodyDisputeParties)
      .where(eq(custodyDisputeParties.id, otherPartyId));
    expect(otherRow.summary).toBe("Posición de la contraparte — no debe borrarse.");

    // case_events reporter_comment notes → redacted to the sentinel.
    if (!caseEventId) throw new Error("caseEventId not set");
    const [ceRow] = await db
      .select({ notes: caseEvents.notes })
      .from(caseEvents)
      .where(eq(caseEvents.id, caseEventId));
    expect(ceRow.notes).toBe("[contenido eliminado a pedido del titular]");

    // Notification content → scrubbed, CTA dropped.
    if (!notificationId) throw new Error("notificationId not set");
    const [nRow] = await db
      .select({
        title: notifications.title,
        body: notifications.body,
        ctaUrl: notifications.ctaUrl,
        ctaLabel: notifications.ctaLabel,
      })
      .from(notifications)
      .where(eq(notifications.id, notificationId));
    expect(nRow.title).toBe("[eliminado]");
    expect(nRow.body).toBe("[contenido eliminado a pedido del titular]");
    expect(nRow.ctaUrl).toBeNull();
    expect(nRow.ctaLabel).toBeNull();

    // A case_events_mutation_override audit row was emitted for the redaction.
    const overrides = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(eq(auditLog.action, "case_events_mutation_override"));
    expect(
      overrides.some((a) => (a.payload as Record<string, unknown>).case_event_id === caseEventId),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PRIV-1 (migration 0166): Web Push registrations are DELETED, not left behind.
// ---------------------------------------------------------------------------
// push_subscriptions.user_id is declared ON DELETE CASCADE to profiles, and the
// table's schema comment says hard deletion happens "only via profiles cascade".
// That cascade never fires: erase_subject_data SOFT-deletes the profile, and the
// auth.users row the caller deletes afterwards has no FK to public.profiles. So
// every endpoint + p256dh/auth key pair used to survive erasure forever. This
// suite proves the rows are gone and that the audit payload counts them.

describe("erase_subject_data — deletes push subscriptions (0166)", () => {
  const subjectEndpoint = `https://push.dim-test.local/subject/${Math.random().toString(36).slice(2)}`;
  const otherEndpoint = `https://push.dim-test.local/other/${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    await resetProfilePIIToFresh(ownerUserId, "SR Test Owner 0166");
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, ownerUserId));
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, otherUserId));

    // Two rows for the subject: one live, one already soft-revoked. Revocation
    // is not erasure — a revoked row still carries the endpoint and both keys,
    // so it must go too.
    await db.insert(pushSubscriptions).values([
      {
        userId: ownerUserId,
        endpoint: subjectEndpoint,
        p256dh: "BSubjectP256dhKeyFixture",
        auth: "subjectAuthFixture",
        userAgent: "Mozilla/5.0 (Subject Device)",
      },
      {
        userId: ownerUserId,
        endpoint: `${subjectEndpoint}-revoked`,
        p256dh: "BSubjectRevokedP256dhFixture",
        auth: "subjectRevokedAuthFixture",
        userAgent: "Mozilla/5.0 (Subject Old Device)",
        revokedAt: new Date(),
      },
    ]);

    // A third party's subscription — MUST survive the subject's erasure.
    await db.insert(pushSubscriptions).values({
      userId: otherUserId,
      endpoint: otherEndpoint,
      p256dh: "BOtherP256dhKeyFixture",
      auth: "otherAuthFixture",
      userAgent: "Mozilla/5.0 (Other Device)",
    });
  });

  afterAll(async () => {
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, otherUserId));
  });

  it("removes every push_subscriptions row of the subject and keeps third-party rows", async () => {
    const before = await db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, ownerUserId));
    expect(before.length).toBe(2);

    const { error } = await callRpcAs(
      ownerUserId,
      sql`SELECT public.erase_subject_data(${ownerUserId}::uuid, '0166 push erasure'::text) AS result`,
    );
    expect(error).toBeNull();

    const after = await db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, ownerUserId));
    expect(after.length).toBe(0);

    // Third-party subscription untouched.
    const others = await db
      .select({ endpoint: pushSubscriptions.endpoint })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, otherUserId));
    expect(others.map((o) => o.endpoint)).toEqual([otherEndpoint]);

    // The erasure audit row reports how many were deleted (same shape as every
    // other step this function counts).
    const audits = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.action, "subject_erasure"), eq(auditLog.targetUserId, ownerUserId)));
    expect(
      audits.some((a) => (a.payload as Record<string, unknown>).push_subscriptions_deleted === 2),
    ).toBe(true);
  });

  it("is idempotent — a re-run finds nothing and counts zero", async () => {
    const { error } = await callRpcAs(
      ownerUserId,
      sql`SELECT public.erase_subject_data(${ownerUserId}::uuid, '0166 push erasure rerun'::text) AS result`,
    );
    expect(error).toBeNull();

    const after = await db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, ownerUserId));
    expect(after.length).toBe(0);

    const audits = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.action, "subject_erasure"), eq(auditLog.targetUserId, ownerUserId)));
    expect(
      audits.some((a) => (a.payload as Record<string, unknown>).push_subscriptions_deleted === 0),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// V1-2 fix A: provable consent persisted at signup (Ley 25.326 art. 5).
// ---------------------------------------------------------------------------
// We call completeIdentityAction end-to-end with a mocked Supabase session
// (see vi.mock at the top of this file). This proves the action itself writes
// tos_accepted_at + tos_version — a gap in column existence would be caught
// by the DB write, and a gap in the action's SET clause would leave the
// columns NULL even though the DB supports them.
//
// Also verifies the COALESCE idempotency: a second call must not overwrite
// the original consent timestamp.

describe("consent persistence (art. 5)", () => {
  // THE VERSION RECORDED IS THE ONE SIGNUP STEP 1 DISPLAYED (review of
  // 1c1ac9f82, 2026-09-24). Step 1 leaves it in raw_app_meta_data.tos_version
  // with the service-role key; step 2 stamps it only if it is a known version,
  // and otherwise stamps the pre-2026-09-24 one — never the server's current.
  // raw_user_meta_data is user-writable (auth.updateUser) and must be IGNORED
  // (review of 2cac7c2ff). Real SQL, real auth.users: the subquery is exactly
  // what a mock could not check.
  type MetaColumn = "raw_app_meta_data" | "raw_user_meta_data";

  async function setVersionMeta(column: MetaColumn, value: string | null) {
    const col = sql.raw(column);
    await db.execute(
      value === null
        ? sql`UPDATE auth.users SET ${col} = COALESCE(${col}, '{}'::jsonb) - 'tos_version' WHERE id = ${otherUserId}::uuid`
        : sql`UPDATE auth.users SET ${col} = COALESCE(${col}, '{}'::jsonb) || jsonb_build_object('tos_version', ${value}::text) WHERE id = ${otherUserId}::uuid`,
    );
  }

  async function completeWithMeta(meta: {
    app?: string | null;
    user?: string | null;
  }): Promise<string | null> {
    await db
      .update(profiles)
      .set({ tosAcceptedAt: null, tosVersion: null, updatedAt: new Date() })
      .where(eq(profiles.id, otherUserId));
    await setVersionMeta("raw_app_meta_data", meta.app ?? null);
    await setVersionMeta("raw_user_meta_data", meta.user ?? null);
    try {
      setMockUserId(otherUserId);
      const fd = new FormData();
      fd.set("firstName", "Test");
      fd.set("lastName", "Consent");
      const result = await completeIdentityAction({ error: null }, fd);
      expect(result.error).toBeNull();
      const [row] = await db
        .select({ tosAcceptedAt: profiles.tosAcceptedAt, tosVersion: profiles.tosVersion })
        .from(profiles)
        .where(eq(profiles.id, otherUserId));
      expect(row.tosAcceptedAt).not.toBeNull();
      return row.tosVersion;
    } finally {
      await setVersionMeta("raw_app_meta_data", null);
      await setVersionMeta("raw_user_meta_data", null);
    }
  }

  it("records the version step 1 displayed when it is a known one", async () => {
    expect(await completeWithMeta({ app: "2026-09-24" })).toBe("2026-09-24");
    expect(await completeWithMeta({ app: "2026-07-23" })).toBe("2026-07-23");
    // The current constant is among the known ones (written out above).
    expect(LEGAL_VERSION).toBe("2026-09-24");
  });

  it("records the PREVIOUS version when step 1 left none (old bundle, pre-change signup)", async () => {
    expect(await completeWithMeta({})).toBe("2026-07-23");
  });

  it("records the PREVIOUS version for an unknown one", async () => {
    expect(await completeWithMeta({ app: "2099-01-01" })).toBe("2026-07-23");
  });

  it("IGNORES a user_metadata version — the user can write that one", async () => {
    // The forgery the review found: sign up on the old sentence, then
    // auth.updateUser({ data: { tos_version: "2026-09-24" } }) before step 2.
    expect(await completeWithMeta({ user: "2026-09-24" })).toBe("2026-07-23");
    // And it cannot DOWNGRADE a server-written one either.
    expect(await completeWithMeta({ app: "2026-09-24", user: "2026-07-23" })).toBe("2026-09-24");
  });

  it("completeIdentityAction on retry preserves the original consent timestamp (COALESCE)", async () => {
    // First call — sets the initial timestamp.
    await db
      .update(profiles)
      .set({ tosAcceptedAt: null, tosVersion: null, updatedAt: new Date() })
      .where(eq(profiles.id, otherUserId));

    setMockUserId(otherUserId);
    const fd = new FormData();
    fd.set("firstName", "Test");
    fd.set("lastName", "Retry");

    await completeIdentityAction({ error: null }, fd);
    const [first] = await db
      .select({ tosAcceptedAt: profiles.tosAcceptedAt })
      .from(profiles)
      .where(eq(profiles.id, otherUserId));
    const originalTs = first.tosAcceptedAt;
    expect(originalTs).not.toBeNull();

    // Second call — must not overwrite the timestamp.
    await completeIdentityAction({ error: null }, fd);
    const [second] = await db
      .select({ tosAcceptedAt: profiles.tosAcceptedAt })
      .from(profiles)
      .where(eq(profiles.id, otherUserId));

    // Timestamps must be identical (COALESCE returns the existing value).
    expect(second.tosAcceptedAt?.toISOString()).toBe(originalTs?.toISOString());
  });
});

// ---------------------------------------------------------------------------
// ARCH-H (migration 0080): audit_log.actor_user_id ON DELETE SET NULL
// ---------------------------------------------------------------------------
// Verifies that:
//   1. Hard-deleting a user profile does NOT delete their audit_log rows.
//   2. The surviving audit rows have actor_user_id = NULL.
//   3. The admin audit view batch name-lookup (inArray on non-null actor ids)
//      completes without error and produces no entry for the deleted actor.

const ARCH_H_ACTOR_EMAIL = "sr-arch-h-actor@dim-test.local";
let archHActorId: string | undefined;
const archHAuditIds: string[] = [];

describe("ARCH-H: audit_log actor hard-delete survivability", () => {
  beforeAll(async () => {
    // Ensure no leftover from previous run.
    const { data: list } = await admin.auth.admin.listUsers();
    const existing = list?.users.find((u) => u.email === ARCH_H_ACTOR_EMAIL);
    if (existing) {
      // Pre-clean: with the new SET NULL FK, we can delete the profile without
      // first clearing audit rows — that is exactly what this test proves.
      // But if there are leftover audit rows from a crashed previous run, we
      // need to clean those up to keep the test's own assertions clean.
      await db.transaction(async (tx) => {
        await setAuditMutationGucs(tx);
        await tx.delete(auditLog).where(eq(auditLog.actorUserId, existing.id));
      });
      await db.delete(profiles).where(eq(profiles.id, existing.id));
      await admin.auth.admin.deleteUser(existing.id);
    }

    // Create a fresh ephemeral actor.
    const { data, error } = await createFreshTestUser(admin, {
      email: ARCH_H_ACTOR_EMAIL,
      password: "ArchH_2026!",
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`ARCH-H createUser: ${error?.message}`);
    archHActorId = data.user.id;

    // Insert two audit_log rows attributed to this actor (bypass append-only
    // guard with allow_audit_mutation so the rows are directly controlled).
    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      const rows = await tx
        .insert(auditLog)
        .values([
          {
            actorUserId: archHActorId,
            action: "request_viewed",
            payload: { test: "arch-h-1" },
          },
          {
            actorUserId: archHActorId,
            action: "request_viewed",
            payload: { test: "arch-h-2" },
          },
        ])
        .returning({ id: auditLog.id });
      for (const r of rows) archHAuditIds.push(r.id);
    });
  });

  afterAll(async () => {
    // Clean up the test audit rows.
    if (archHAuditIds.length > 0) {
      await db.transaction(async (tx) => {
        await setAuditMutationGucs(tx);
        await tx.delete(auditLog).where(inArray(auditLog.id, archHAuditIds));
      });
    }
  });

  it("hard-deleting the actor profile does not delete the audit rows", async () => {
    if (!archHActorId) throw new Error("archHActorId not set");

    // Hard-delete: profile row first, then auth user.
    // With ON DELETE RESTRICT this would throw a FK violation.
    // With ON DELETE SET NULL it must succeed.
    await db.delete(profiles).where(eq(profiles.id, archHActorId));
    await admin.auth.admin.deleteUser(archHActorId);

    // The two audit rows must still exist.
    const surviving = await db
      .select({ id: auditLog.id, actorUserId: auditLog.actorUserId })
      .from(auditLog)
      .where(inArray(auditLog.id, archHAuditIds));

    expect(surviving).toHaveLength(2);
    // actor_user_id must be NULL on all surviving rows.
    for (const row of surviving) {
      expect(row.actorUserId).toBeNull();
    }
  });

  it("admin audit view batch name-lookup handles NULL actor_user_id without error", async () => {
    // Simulate the admin auditoria page batch lookup:
    //   collect non-null actor ids → inArray query → no crash, no result for deleted actor.
    const rows = await db
      .select({ id: auditLog.id, actorUserId: auditLog.actorUserId })
      .from(auditLog)
      .where(inArray(auditLog.id, archHAuditIds));

    // Filter to non-null ids (mirrors the auditoria page logic after ARCH-H fix).
    const actorIds = Array.from(
      new Set(rows.map((r) => r.actorUserId).filter((id): id is string => id !== null)),
    );

    // actorIds must be empty because actor was deleted → all null.
    expect(actorIds).toHaveLength(0);

    // The inArray lookup with an empty array must be skipped (mirrors page guard).
    // We verify the query is a no-op and returns an empty map.
    const namesById = new Map<string, string>();
    if (actorIds.length > 0) {
      const profileRows = await db
        .select({ id: profiles.id, displayName: profiles.displayName })
        .from(profiles)
        .where(inArray(profiles.id, actorIds));
      for (const r of profileRows) namesById.set(r.id, r.displayName);
    }
    expect(namesById.size).toBe(0);
  });

  it("audit rows with NULL actor_user_id are returned by isNull filter", async () => {
    const nullActorRows = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(isNull(auditLog.actorUserId));
    // At least the two rows we created must appear in the NULL-actor set.
    const ourIds = new Set(archHAuditIds);
    const found = nullActorRows.filter((r) => ourIds.has(r.id));
    expect(found).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// ARCH-H: trigger passthrough abuse — enforce_audit_log_append_only hardening
// ---------------------------------------------------------------------------
// The narrow FK-nullification passthrough added in migration 0080 must not be
// abusable to mutate other business columns simultaneously.
//
// Three rejection cases:
//   A. UPDATE sets actor_user_id NULL *and* changes payload — REJECTED.
//   B. UPDATE sets actor_user_id NULL when it is already NULL — REJECTED
//      (null→null is not a FK cascade, it is a no-op probe or abuse attempt).
//   C. UPDATE changes actor_user_id from non-null to a different non-null UUID
//      — REJECTED (FK cascade only ever sets to NULL, never to another value).

const ABUSE_ACTOR_EMAIL = "sr-abuse-guard@dim-test.local";
let abuseActorId: string | undefined;
const abuseAuditIds: string[] = [];

describe("ARCH-H: trigger passthrough abuse rejection", () => {
  beforeAll(async () => {
    // Reuse or create a stable ephemeral actor for these tests.
    const { data: list } = await admin.auth.admin.listUsers();
    const existing = list?.users.find((u) => u.email === ABUSE_ACTOR_EMAIL);
    if (existing) {
      abuseActorId = existing.id;
      // Clean up any leftover audit rows from a previous crashed run.
      await db.transaction(async (tx) => {
        await setAuditMutationGucs(tx);
        await tx.delete(auditLog).where(eq(auditLog.actorUserId, existing.id));
      });
    } else {
      const { data, error } = await createFreshTestUser(admin, {
        email: ABUSE_ACTOR_EMAIL,
        password: "AbuseGuard_2026!",
        email_confirm: true,
      });
      if (error || !data.user) throw new Error(`ABUSE-GUARD createUser: ${error?.message}`);
      abuseActorId = data.user.id;
    }

    // Insert two controlled audit rows.
    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      const rows = await tx
        .insert(auditLog)
        .values([
          {
            actorUserId: abuseActorId,
            action: "request_viewed",
            payload: { test: "abuse-guard-non-null" },
          },
          {
            actorUserId: null,
            action: "request_viewed",
            payload: { test: "abuse-guard-null-actor" },
          },
        ])
        .returning({ id: auditLog.id });
      for (const r of rows) abuseAuditIds.push(r.id);
    });
  });

  afterAll(async () => {
    if (abuseAuditIds.length > 0) {
      await db.transaction(async (tx) => {
        await setAuditMutationGucs(tx);
        await tx.delete(auditLog).where(inArray(auditLog.id, abuseAuditIds));
      });
    }
  });

  it("A: UPDATE that sets actor_user_id=NULL while also changing payload is rejected", async () => {
    // abuseAuditIds[0] has a non-null actor. Attempt to null the actor AND
    // change the payload in the same statement — the trigger must reject this
    // because it is not a pure FK cascade nullification.
    //
    // postgres.js rolls back and re-throws from db.transaction(), not from
    // the inner execute() — catch at the outer level.
    const nonNullRowId = abuseAuditIds[0];
    if (!nonNullRowId) throw new Error("abuseAuditIds[0] not set");

    let caughtCode: string | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE public.audit_log
              SET actor_user_id = NULL,
                  payload = '{"test":"tampered"}'::jsonb
              WHERE id = ${nonNullRowId}`,
        );
      });
    } catch (err) {
      // drizzle 0.45 wraps the pg error; pgErrorCode unwraps the `.cause` chain.
      caughtCode = pgErrorCode(err) ?? undefined;
    }

    expect(caughtCode).toBeDefined();
    // SQLSTATE 23001 = restrict_violation (raised by the trigger).
    expect(caughtCode).toBe("23001");
  });

  it("B: UPDATE that sets actor_user_id=NULL when it is already NULL is rejected", async () => {
    // abuseAuditIds[1] already has actor_user_id = NULL. Setting it to NULL
    // again is not a FK cascade — the trigger must reject it.
    const nullActorRowId = abuseAuditIds[1];
    if (!nullActorRowId) throw new Error("abuseAuditIds[1] not set");

    let caughtCode: string | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE public.audit_log
              SET actor_user_id = NULL
              WHERE id = ${nullActorRowId}`,
        );
      });
    } catch (err) {
      // drizzle 0.45 wraps the pg error; pgErrorCode unwraps the `.cause` chain.
      caughtCode = pgErrorCode(err) ?? undefined;
    }

    expect(caughtCode).toBeDefined();
    expect(caughtCode).toBe("23001");
  });

  it("C: UPDATE that changes actor_user_id from non-null to a different non-null UUID is rejected", async () => {
    // FK cascade only ever sets FK columns to NULL — a non-null→non-null change
    // is definitively not a cascade and must be rejected.
    const nonNullRowId = abuseAuditIds[0];
    if (!nonNullRowId) throw new Error("abuseAuditIds[0] not set");

    const otherUuid = "00000000-0000-0000-0000-000000000001";
    let caughtCode: string | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE public.audit_log
              SET actor_user_id = ${otherUuid}::uuid
              WHERE id = ${nonNullRowId}`,
        );
      });
    } catch (err) {
      // drizzle 0.45 wraps the pg error; pgErrorCode unwraps the `.cause` chain.
      caughtCode = pgErrorCode(err) ?? undefined;
    }

    expect(caughtCode).toBeDefined();
    expect(caughtCode).toBe("23001");
  });

  // -------------------------------------------------------------------------
  // Migration 0085: generalized trigger — tests for the NEW FK columns
  // -------------------------------------------------------------------------
  // The trigger now guards ALL nullable FK columns (target_user_id,
  // target_organization_id, target_govt_assignment_id, approval_request_id)
  // with the same rules as actor_user_id.  The cases below exercise the
  // extended surface.

  it("D: UPDATE that changes target_user_id from non-null to a different non-null UUID is rejected", async () => {
    // abuseAuditIds[0] was inserted with target_user_id = NULL. We need a row
    // that has a non-null target_user_id to test reassignment rejection.
    // Insert a fresh controlled row inside the bypass window.
    let targetUserId: string | undefined;
    const rowIds: string[] = [];
    try {
      // Reuse abuseActorId as the target_user_id (an existing profile UUID).
      targetUserId = abuseActorId;
      await db.transaction(async (tx) => {
        await setAuditMutationGucs(tx);
        const rows = await tx
          .insert(auditLog)
          .values([
            {
              actorUserId: abuseActorId,
              action: "request_viewed" as const,
              targetUserId: abuseActorId,
              payload: { test: "target-user-reassign" },
            },
          ])
          .returning({ id: auditLog.id });
        for (const r of rows) rowIds.push(r.id);
      });

      const rowId = rowIds[0];
      if (!rowId) throw new Error("rowIds[0] not set");

      const otherUuid = "00000000-0000-0000-0000-000000000002";
      let caughtCode: string | undefined;
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`UPDATE public.audit_log
                SET target_user_id = ${otherUuid}::uuid
                WHERE id = ${rowId}`,
          );
        });
      } catch (err) {
        // drizzle 0.45 wraps the pg error; pgErrorCode unwraps the `.cause` chain.
        caughtCode = pgErrorCode(err) ?? undefined;
      }

      expect(caughtCode).toBeDefined();
      expect(caughtCode).toBe("23001");
    } finally {
      if (rowIds.length > 0) {
        await db.transaction(async (tx) => {
          await setAuditMutationGucs(tx);
          await tx.delete(auditLog).where(inArray(auditLog.id, rowIds));
        });
      }
    }
  });

  it("E: UPDATE that nullifies target_user_id while also tampering payload is rejected", async () => {
    // Nullifying a FK column is allowed ONLY when the four immutable columns
    // (id, action, payload, performed_at) are unchanged. Changing payload at the
    // same time must be rejected regardless of the FK nullification.
    const rowIds: string[] = [];
    try {
      await db.transaction(async (tx) => {
        await setAuditMutationGucs(tx);
        const rows = await tx
          .insert(auditLog)
          .values([
            {
              actorUserId: abuseActorId,
              action: "request_viewed" as const,
              targetUserId: abuseActorId,
              payload: { test: "target-user-null-plus-payload-tamper" },
            },
          ])
          .returning({ id: auditLog.id });
        for (const r of rows) rowIds.push(r.id);
      });

      const rowId = rowIds[0];
      if (!rowId) throw new Error("rowIds[0] not set");

      let caughtCode: string | undefined;
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`UPDATE public.audit_log
                SET target_user_id = NULL,
                    payload = '{"test":"tampered"}'::jsonb
                WHERE id = ${rowId}`,
          );
        });
      } catch (err) {
        // drizzle 0.45 wraps the pg error; pgErrorCode unwraps the `.cause` chain.
        caughtCode = pgErrorCode(err) ?? undefined;
      }

      expect(caughtCode).toBeDefined();
      expect(caughtCode).toBe("23001");
    } finally {
      if (rowIds.length > 0) {
        await db.transaction(async (tx) => {
          await setAuditMutationGucs(tx);
          await tx.delete(auditLog).where(inArray(auditLog.id, rowIds));
        });
      }
    }
  });

  it("F: UPDATE that nullifies target_organization_id (legitimate cascade shape) is ALLOWED", async () => {
    // The trigger must pass through a pure FK cascade nullification where only
    // a nullable FK column changes from non-NULL to NULL and all four immutable
    // columns are unchanged. This is the exact shape produced by
    // `DELETE FROM organizations` → ON DELETE SET NULL.
    //
    // We cannot actually insert a real organization here cheaply, so we simulate
    // the cascade shape directly: insert a row with a known UUID in
    // target_organization_id via bypass, then attempt the nullification without
    // the bypass. The trigger should allow it.
    const rowIds: string[] = [];
    try {
      // Use a dummy UUID that looks like an org id — the FK is deferrable enough
      // for the bypass insert (the bypass GUC skips trigger checks). We just need
      // a non-null value to prove the non-null → NULL transition is allowed.
      // However, the FK constraint itself will reject an unknown UUID even with
      // the GUC, so we reuse abuseActorId (a real profile UUID) for the org id
      // column insert... but that won't work either because target_organization_id
      // references organizations.id (a different table). The cleanest approach is
      // to insert a real org, then use its id, then clean up. We use the raw
      // bypass window for the insert + cleanup, and the non-bypass UPDATE as the
      // assertion step.
      //
      // Alternative: use an org that already exists in the test DB from another
      // suite. But that creates test-ordering coupling. Instead we create a
      // minimal org inline.
      const { organizations: orgsTable } = await import("@/db");
      const [testOrg] = await db
        .insert(orgsTable)
        .values({
          publicToken: "AUDIT-ABUSE-TEST",
          legalName: "Audit Abuse Test Org",
          displayName: "Audit Abuse Test",
          orgType: "shelter",
          email: "audit-abuse-test-org@dim-test.local",
        })
        .returning({ id: orgsTable.id });
      if (!testOrg) throw new Error("Failed to insert test org");

      await db.transaction(async (tx) => {
        await setAuditMutationGucs(tx);
        const rows = await tx
          .insert(auditLog)
          .values([
            {
              actorUserId: abuseActorId,
              action: "request_viewed" as const,
              targetOrganizationId: testOrg.id,
              payload: { test: "org-null-cascade" },
            },
          ])
          .returning({ id: auditLog.id });
        for (const r of rows) rowIds.push(r.id);
      });

      const rowId = rowIds[0];
      if (!rowId) throw new Error("rowIds[0] not set");

      // This UPDATE (without bypass) simulates what ON DELETE SET NULL produces.
      // The trigger must allow it because: immutable columns unchanged + only
      // target_organization_id changes from non-NULL → NULL.
      let caughtErr: unknown;
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`UPDATE public.audit_log
                SET target_organization_id = NULL
                WHERE id = ${rowId}`,
          );
        });
      } catch (err) {
        caughtErr = err;
      }

      // No exception should have been thrown — the trigger allows this shape.
      expect(caughtErr).toBeUndefined();

      // Clean up the org (also cascades the audit row's FK to NULL, which is fine).
      await db.delete(orgsTable).where(eq(orgsTable.id, testOrg.id));
    } finally {
      if (rowIds.length > 0) {
        await db.transaction(async (tx) => {
          await setAuditMutationGucs(tx);
          // The row may already have target_organization_id = NULL at this point
          // (either from the allowed UPDATE or from the org DELETE cascade).
          await tx.delete(auditLog).where(inArray(auditLog.id, rowIds));
        });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 0226 — the erasure reaches the notification dead letter (A06-G2), and 0228
// redacts its error_message too (HIGH-1)
// ---------------------------------------------------------------------------
//
// A dead letter stores the full notification insert, and the drain cron replays
// it into public.notifications. Before 0226 the erasure redacted the subject's
// notifications and left these rows alone, so the next drain re-created what
// art. 16 had just removed.
describe("erase_subject_data — redacts the subject's notification dead letters (0226)", () => {
  const KEY_PREFIX = "sr-0226-dead-letter";
  const NL = String.fromCharCode(10);

  function deadLetterFor(userId: string, suffix: string, resolved: boolean) {
    const dedupeKey = `${KEY_PREFIX}:${suffix}:${userId}`;
    return {
      dedupeKey,
      payload: {
        userId,
        notificationType: "pet_found_report",
        title: "Encontraron a Pochi",
        body: "Roberto Sánchez la tiene. Contacto: 11-9999-8888",
        dedupeKey,
      },
      // What drizzle's DrizzleQueryError put here before the write side was
      // sanitised: the query and its params, i.e. the notification (0228).
      errorMessage: `Failed query: insert into "notifications" ("user_id", "title") values ($1, $2)${NL}params: ${userId},Roberto Sánchez 11-9999-8888`,
      resolvedAt: resolved ? new Date("2026-09-01T12:00:00Z") : null,
    };
  }

  beforeAll(async () => {
    await db
      .delete(notificationDeadLetter)
      .where(like(notificationDeadLetter.dedupeKey, `${KEY_PREFIX}:%`));
    await db
      .insert(notificationDeadLetter)
      .values([
        deadLetterFor(ownerUserId, "pending", false),
        deadLetterFor(ownerUserId, "resolved", true),
        deadLetterFor(otherUserId, "pending", false),
      ]);
  });

  afterAll(async () => {
    await db
      .delete(notificationDeadLetter)
      .where(like(notificationDeadLetter.dedupeKey, `${KEY_PREFIX}:%`));
  });

  it("empties the payload of every dead letter addressed to the subject, and resolves it", async () => {
    const { error } = await callRpcAs(
      ownerUserId,
      sql`SELECT public.erase_subject_data(${ownerUserId}::uuid, 'dead letter redaction'::text) AS result`,
    );
    expect(error).toBeNull();

    const rows = await db
      .select()
      .from(notificationDeadLetter)
      .where(like(notificationDeadLetter.dedupeKey, `${KEY_PREFIX}:%:${ownerUserId}`));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.payload).toEqual({});
      // Marked resolved, so the drain never scans it again.
      expect(row.resolvedAt).not.toBeNull();
      // error_message held the query params — the notification itself — so it
      // is redacted too (0228 corrects 0226, which kept it).
      expect(row.errorMessage).toBe("[redacted]");
      expect(row.dedupeKey).toMatch(new RegExp(`^${KEY_PREFIX}:`));
    }
    // A row already resolved keeps its original resolution time.
    const resolved = rows.find((r) => r.dedupeKey?.includes(":resolved:"));
    expect(resolved?.resolvedAt?.toISOString()).toBe("2026-09-01T12:00:00.000Z");
  });

  it("leaves another person's dead letter untouched", async () => {
    const [row] = await db
      .select()
      .from(notificationDeadLetter)
      .where(eq(notificationDeadLetter.dedupeKey, `${KEY_PREFIX}:pending:${otherUserId}`));
    expect(row?.payload).toMatchObject({ userId: otherUserId, title: "Encontraron a Pochi" });
    expect(row?.resolvedAt).toBeNull();
    expect(row?.errorMessage).toContain("params:");
  });

  it("counts the redaction in the subject_erasure audit payload", async () => {
    const [entry] = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.action, "subject_erasure"), eq(auditLog.targetUserId, ownerUserId)))
      .orderBy(desc(auditLog.performedAt))
      .limit(1);
    expect(entry?.payload).toMatchObject({ dead_letters_redacted: 2 });
  });
});
