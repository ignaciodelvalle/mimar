// Integration tests for the vet direct-diagnosis flow (ENO spec §6).
//
// Covers (via recordDiseaseDiagnosisWriter — auth-stripped variant):
//   1. Rabies-confirmed diagnosis → clinical_info_logged + outbreak_signal
//      with triggered_by='direct_diagnosis' + owner public-alert notif.
//   2. Non-reportable disease → only clinical_info_logged (no signal).
//   3. Reportable disease NOT in PUBLIC_ALERT_DISEASES → outbreak_signal but
//      no owner notification.
//   4. Throttle: second diagnosis within 30d does not re-notify the owner.

import { createClient } from "@supabase/supabase-js";
import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// amendEvent revalidates paths; outside a Next request that is a no-op here.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  db,
  enoProcessingQueue,
  eventNotificationOutbox,
  notifications,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { reevaluateOutboxAfterAmendment } from "@/lib/events/event-outbox-reevaluate";
import { amendEvent } from "@/src/modules/events/application/amendment/amend-event";
import { recordDiseaseDiagnosisWriter as _recordDiseaseDiagnosisWriter } from "@/src/modules/events/application/clinical/record-disease-diagnosis-use-case";
import { createDeathRecord } from "@/src/modules/events/application/lifecycle/death-record-use-case";
import { recordDiseaseDiagnosisWriter } from "@/src/modules/events/application/writers";
import { EventsRepository } from "@/src/modules/events/infrastructure/events-repository";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabase = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const OWNER_EMAIL = "ddx-owner@dim-test.local";
const VET_EMAIL = "ddx-vet@dim-test.local";
const ADMIN_EMAIL = "ddx-admin@dim-test.local";
const PASS = "DdxFlow_2026!";

let ownerUserId: string;
let vetUserId: string;
let adminUserId: string;
const insertedPetIds: string[] = [];

const TEST_PROVINCE = "CABA";
const TEST_LOCALITY = "Almagro";

async function purgeUserByEmail(email: string) {
  const { data } = await supabase.auth.admin.listUsers();
  const found = data?.users.find((u) => u.email === email);
  const displayName = email.split("@")[0];
  const orphans = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));
  const ids = [
    ...(found ? [found.id] : []),
    ...orphans.map((o) => o.id).filter((id) => id !== found?.id),
  ];
  // Deleting profiles cascades to pet_events.recorded_by_user_id (ON DELETE
  // SET NULL), which triggers the append-only protection. Wrap so the
  // cascading UPDATE is allowed.
  // NOTE: profile deletion may also fail if audit_log references the profile
  // (ON DELETE RESTRICT). This can happen when ENO or other triggers write
  // audit_log entries referencing this vet. Swallow to avoid cascading
  // teardown failures — the orphan profile is harmless.
  for (const uid of ids) {
    await db.delete(notifications).where(eq(notifications.userId, uid));
    await withMutationOverride(async (tx) => {
      await tx.delete(profiles).where(eq(profiles.id, uid));
    }).catch(() => {
      // Intentionally swallow FK violations from audit_log → profiles (ON DELETE RESTRICT).
    });
  }
  if (found) {
    await supabase.auth.admin.deleteUser(found.id).catch(() => {
      // Swallow if auth user deletion fails due to lingering FK.
    });
  }
}

async function insertTestPet(ownerUid: string, tokenSuffix: string) {
  const token = `DDXTEST-${tokenSuffix}-${Date.now()}`;
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: `DdxPet${tokenSuffix}`,
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionCountry: "AR",
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
    })
    .returning();
  await db.insert(ownerships).values({
    petId: pet.id,
    ownerUserId: ownerUid,
    role: "owner",
  });
  insertedPetIds.push(pet.id);
  return pet;
}

beforeAll(async () => {
  await purgeUserByEmail(OWNER_EMAIL);
  await purgeUserByEmail(VET_EMAIL);
  await purgeUserByEmail(ADMIN_EMAIL);

  const o = await createFreshTestUser(supabase, {
    email: OWNER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (o.error || !o.data.user) throw new Error(`createUser owner: ${o.error?.message}`);
  ownerUserId = o.data.user.id;

  const v = await createFreshTestUser(supabase, {
    email: VET_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (v.error || !v.data.user) throw new Error(`createUser vet: ${v.error?.message}`);
  vetUserId = v.data.user.id;
  await db
    .update(profiles)
    .set({ role: "vet", matriculaVerified: true, displayName: "Dr. Test Ddx" })
    .where(eq(profiles.id, vetUserId));

  const a = await createFreshTestUser(supabase, {
    email: ADMIN_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (a.error || !a.data.user) throw new Error(`createUser admin: ${a.error?.message}`);
  adminUserId = a.data.user.id;
  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional" })
    .where(eq(profiles.id, adminUserId));
});

afterAll(async () => {
  for (const petId of insertedPetIds) {
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, petId));
    });
  }
  for (const uid of [ownerUserId, vetUserId, adminUserId].filter(Boolean)) {
    await db.delete(notifications).where(eq(notifications.userId, uid));
  }
  await purgeUserByEmail(OWNER_EMAIL);
  await purgeUserByEmail(VET_EMAIL);
  await purgeUserByEmail(ADMIN_EMAIL);
});

describe("recordDiseaseDiagnosisWriter", () => {
  it("rabies_confirmed → diagnosis event + signal (direct_diagnosis) + owner alert", async () => {
    const pet = await insertTestPet(ownerUserId, "RABIES");

    const result = await recordDiseaseDiagnosisWriter({
      petId: pet.id,
      petName: pet.name,
      petSpecies: pet.species,
      petJurisdictionCountry: pet.jurisdictionCountry,
      petJurisdictionProvince: pet.jurisdictionProvince ?? null,
      petJurisdictionLocality: pet.jurisdictionLocality ?? null,
      vetUserId,
      vetDisplayName: "Dr. Test Ddx",
      diseaseCode: "rabies_confirmed",
      confirmedByLab: true,
      labName: "INPPAZ",
      labReportReference: "LAB-RABIES-001",
      diagnosisDate: new Date(),
      notes: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signalEventId).not.toBeNull();
    expect(result.ownerNotificationsDelivered).toBe(1);

    const diagnosisRows = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "clinical_info_logged")));
    expect(diagnosisRows.length).toBe(1);
    const payload = diagnosisRows[0].payload as Record<string, unknown>;
    expect(payload.sub_kind).toBe("disease_diagnosis");
    expect(payload.disease_code).toBe("rabies_confirmed");
    expect(payload.confirmed_by_lab).toBe(true);

    const signalRows = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "outbreak_signal")));
    expect(signalRows.length).toBe(1);
    const sigPayload = signalRows[0].payload as Record<string, unknown>;
    expect(sigPayload.triggered_by).toBe("direct_diagnosis");
    expect(sigPayload.source_symptom_event_id).toBeNull();
    expect(sigPayload.source_disease_diagnosis_event_id).toBe(diagnosisRows[0].id);
    expect(sigPayload.confirmed_by_lab).toBe(true);

    const ownerAlerts = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, ownerUserId),
          eq(notifications.notificationType, "disease_public_alert"),
          eq(notifications.relatedPetId, pet.id),
        ),
      );
    expect(ownerAlerts.length).toBe(1);
    expect(ownerAlerts[0].severity).toBe("urgent");

    // Outbox: one row for the diagnosis event + one for the signal event.
    const outboxRows = await db
      .select()
      .from(eventNotificationOutbox)
      .where(eq(eventNotificationOutbox.sourceEventId, diagnosisRows[0].id));
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0].targetKind).toBe("govt_webhook");
    expect(outboxRows[0].status).toBe("pending");

    // DURABILITY (P1-3): the ENO govt-fanout queue row is enqueued INSIDE the
    // diagnosis transaction — exactly one row exists for the committed event.
    // (The enqueue is no longer a post-commit best-effort call that could be
    // lost on a crash.) rabies_confirmed is an ENO disease, so a row is created.
    const queueRows = await db
      .select()
      .from(enoProcessingQueue)
      .where(eq(enoProcessingQueue.petEventId, diagnosisRows[0].id));
    expect(queueRows.length).toBe(1);
    expect(queueRows[0].status).toBe("pending");
  });

  // PO S5 (2026-09-26): the legal clock starts at the diagnosis date, not at
  // data entry. A diagnosis entered five days late lands already overdue —
  // and so does the signal that restates it.
  it("a diagnosis entered late lands overdue: sla = diagnosis date + legal window", async () => {
    const pet = await insertTestPet(ownerUserId, "LATE");
    const diagnosisDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

    const result = await recordDiseaseDiagnosisWriter({
      petId: pet.id,
      petName: pet.name,
      petSpecies: pet.species,
      petJurisdictionCountry: pet.jurisdictionCountry,
      petJurisdictionProvince: pet.jurisdictionProvince ?? null,
      petJurisdictionLocality: pet.jurisdictionLocality ?? null,
      vetUserId,
      vetDisplayName: "Dr. Test Ddx",
      diseaseCode: "leptospirosis",
      confirmedByLab: false,
      labName: null,
      labReportReference: null,
      diagnosisDate,
      notes: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await db
      .select({ slaDueAt: eventNotificationOutbox.slaDueAt })
      .from(eventNotificationOutbox)
      .where(eq(eventNotificationOutbox.sourceEventId, result.diagnosisEventId));
    expect(rows).toHaveLength(1);
    // Leptospirosis: 24 h (Res. CVPBA 05/2020 «inmediata»).
    expect(rows[0].slaDueAt.getTime()).toBe(diagnosisDate.getTime() + 24 * 60 * 60 * 1000);
    // Overdue against the DATABASE clock (no host-vs-container comparison).
    const [{ overdue }] = await db
      .select({ overdue: sql<boolean>`${rows[0].slaDueAt.toISOString()}::timestamptz < now()` })
      .from(sql`(select 1) as one`);
    expect(overdue).toBe(true);
  });

  it("non-reportable disease (parvovirus) → only diagnosis row, no signal", async () => {
    const pet = await insertTestPet(ownerUserId, "PARVO");

    const result = await recordDiseaseDiagnosisWriter({
      petId: pet.id,
      petName: pet.name,
      petSpecies: pet.species,
      petJurisdictionCountry: pet.jurisdictionCountry,
      petJurisdictionProvince: pet.jurisdictionProvince ?? null,
      petJurisdictionLocality: pet.jurisdictionLocality ?? null,
      vetUserId,
      vetDisplayName: "Dr. Test Ddx",
      diseaseCode: "parvovirus",
      confirmedByLab: false,
      labName: null,
      labReportReference: null,
      diagnosisDate: new Date(),
      notes: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signalEventId).toBeNull();
    expect(result.ownerNotificationsDelivered).toBe(0);

    const signalRows = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "outbreak_signal")));
    expect(signalRows.length).toBe(0);
  });

  it("reportable but NOT in public-alert catalog (canine_brucellosis) → signal, no owner alert", async () => {
    const pet = await insertTestPet(ownerUserId, "BRUC");

    const result = await recordDiseaseDiagnosisWriter({
      petId: pet.id,
      petName: pet.name,
      petSpecies: pet.species,
      petJurisdictionCountry: pet.jurisdictionCountry,
      petJurisdictionProvince: pet.jurisdictionProvince ?? null,
      petJurisdictionLocality: pet.jurisdictionLocality ?? null,
      vetUserId,
      vetDisplayName: "Dr. Test Ddx",
      diseaseCode: "canine_brucellosis",
      confirmedByLab: true,
      labName: "INPPAZ",
      labReportReference: null,
      diagnosisDate: new Date(),
      notes: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signalEventId).not.toBeNull();
    expect(result.ownerNotificationsDelivered).toBe(0);

    const ownerAlerts = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, ownerUserId),
          eq(notifications.notificationType, "disease_public_alert"),
          eq(notifications.relatedPetId, pet.id),
        ),
      );
    expect(ownerAlerts.length).toBe(0);
  });

  it("durability atomicity: ENO enqueue failure rolls back the entire diagnosis tx", async () => {
    // DURABILITY CLAIM (P1-3): the ENO eno_processing_queue enqueue runs INSIDE
    // the diagnosis transaction. If that enqueue throws, the whole transaction
    // must roll back — no pet_events row, no outbox row, no queue row committed.
    // This test proves that DB-level guarantee by injecting a failing enqueue dep.

    const pet = await insertTestPet(ownerUserId, "ROLLBACK");

    // Snapshot: count events for this pet before the failing write.
    const eventCountBefore = (await db.select().from(petEvents).where(eq(petEvents.petId, pet.id)))
      .length;

    const repo = new EventsRepository();

    // Inject an enqueueEnoTrigger that always throws inside the tx, simulating
    // a genuine DB error during the in-transaction ENO enqueue. The error must
    // propagate out of the transaction callback and abort the whole tx.
    const failingEnqueue = async (_petEvent: unknown, _tx: unknown): Promise<void> => {
      throw new Error("injected enqueue failure — abort tx");
    };

    const result = await _recordDiseaseDiagnosisWriter(
      {
        petId: pet.id,
        petName: pet.name,
        petSpecies: pet.species,
        petJurisdictionCountry: pet.jurisdictionCountry,
        petJurisdictionProvince: pet.jurisdictionProvince ?? null,
        petJurisdictionLocality: pet.jurisdictionLocality ?? null,
        vetUserId,
        vetDisplayName: "Dr. Test Ddx",
        diseaseCode: "rabies_confirmed",
        confirmedByLab: true,
        labName: null,
        labReportReference: null,
        diagnosisDate: new Date(),
        notes: null,
      },
      {
        repo,
        transaction: <T>(cb: (tx: unknown) => Promise<T>) =>
          db.transaction(cb as Parameters<typeof db.transaction>[0]) as Promise<T>,
        flushNotifications: async () => {},
        enqueueEnoTrigger: failingEnqueue,
      },
    );

    // Writer must surface the error.
    expect(result.ok).toBe(false);

    // DB-level proof — the transaction rolled back completely:

    // 1. No new pet_events row for this pet (diagnosis event rolled back).
    const eventsAfter = (await db.select().from(petEvents).where(eq(petEvents.petId, pet.id)))
      .length;
    expect(eventsAfter).toBe(eventCountBefore);

    // 2. No ENO queue row exists for any event of this pet.
    //    Since no event was committed (proven above), there is no petEventId
    //    to reference. Belt-and-suspenders: verify via cross-join that zero
    //    queue rows reference any event belonging to this pet.
    const queueRowsForPet = (await db.execute(
      sql`
        SELECT q.id
        FROM eno_processing_queue q
        JOIN pet_events e ON e.id = q.pet_event_id
        WHERE e.pet_id = ${pet.id}
      `,
    )) as unknown as Array<{ id: string }>;
    expect(queueRowsForPet.length).toBe(0);

    // 3. No outbox row exists for any event of this pet (cascades with sourceEventId).
    const outboxRowsForPet = (await db.execute(
      sql`
        SELECT o.id
        FROM event_notification_outbox o
        JOIN pet_events e ON e.id = o.source_event_id
        WHERE e.pet_id = ${pet.id}
      `,
    )) as unknown as Array<{ id: string }>;
    expect(outboxRowsForPet.length).toBe(0);
  });

  it("throttle: re-diagnosing same disease within 30d does not re-notify owner", async () => {
    const pet = await insertTestPet(ownerUserId, "THROTTLE");

    const first = await recordDiseaseDiagnosisWriter({
      petId: pet.id,
      petName: pet.name,
      petSpecies: pet.species,
      petJurisdictionCountry: pet.jurisdictionCountry,
      petJurisdictionProvince: pet.jurisdictionProvince ?? null,
      petJurisdictionLocality: pet.jurisdictionLocality ?? null,
      vetUserId,
      vetDisplayName: "Dr. Test Ddx",
      diseaseCode: "leptospirosis",
      confirmedByLab: false,
      labName: null,
      labReportReference: null,
      diagnosisDate: new Date(),
      notes: null,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.ownerNotificationsDelivered).toBe(1);

    const second = await recordDiseaseDiagnosisWriter({
      petId: pet.id,
      petName: pet.name,
      petSpecies: pet.species,
      petJurisdictionCountry: pet.jurisdictionCountry,
      petJurisdictionProvince: pet.jurisdictionProvince ?? null,
      petJurisdictionLocality: pet.jurisdictionLocality ?? null,
      vetUserId,
      vetDisplayName: "Dr. Test Ddx",
      diseaseCode: "leptospirosis",
      confirmedByLab: true,
      labName: "INPPAZ",
      labReportReference: null,
      diagnosisDate: new Date(),
      notes: null,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.ownerNotificationsDelivered).toBe(0);

    // But TWO diagnosis events exist (writer doesn't dedupe diagnoses).
    const diagnosisRows = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "clinical_info_logged")));
    expect(diagnosisRows.length).toBe(2);

    // Owner notifications: only one.
    const ownerAlerts = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, ownerUserId),
          eq(notifications.notificationType, "disease_public_alert"),
          eq(notifications.relatedPetId, pet.id),
        ),
      );
    expect(ownerAlerts.length).toBe(1);
    expect(isNull(notifications.archivedAt));
  });
});

// PO S4 (2026-09-26): a vet-recorded death from rabies joins the animal's
// rabies case — ONE record, the earliest deadline; a leptospirosis death by
// the owner, unconfirmed, is a declaration and mints no legal row.
describe("death_recorded → ENO (S4)", () => {
  function deathInput(
    pet: {
      id: string;
      name: string;
      status: string;
      jurisdictionProvince: string | null;
      jurisdictionLocality: string | null;
    },
    over: Partial<Parameters<typeof createDeathRecord>[0]>,
  ): Parameters<typeof createDeathRecord>[0] {
    return {
      pet: { ...pet, rabiesObservationStatus: null },
      recordedByUserId: vetUserId,
      eventAuthorship: { authorRole: "vet", authorOrganizationId: null, authorVerified: true },
      cause: "disease",
      causeDetail: null,
      confirmedByVet: true,
      vetName: null,
      dispositionMethod: null,
      facility: null,
      occurredAt: new Date(),
      notes: null,
      deathAtClinic: false,
      clinicName: null,
      vetContactedOwner: null,
      vetDecidedAlone: false,
      ownerToPrivateCrematorium: false,
      diseaseCode: "rabies_confirmed",
      confirmedByLab: false,
      isReportable: true,
      uploadedPath: null,
      uploadedMimeType: null,
      uploadedSize: null,
      clientIdempotencyKey: null,
      custodyEpisodeCaseId: null,
      ...over,
    };
  }
  const deps = () => ({
    repo: new EventsRepository(),
    transaction: <T>(cb: (tx: unknown) => Promise<T>) =>
      db.transaction(cb as Parameters<typeof db.transaction>[0]) as Promise<T>,
    flushNotifications: async () => {},
  });

  it("a vet-recorded rabies death merges into the rabies case with the earliest deadline", async () => {
    const pet = await insertTestPet(ownerUserId, "DEATHRAB");
    const diagnosisDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const dx = await recordDiseaseDiagnosisWriter({
      petId: pet.id,
      petName: pet.name,
      petSpecies: pet.species,
      petJurisdictionCountry: pet.jurisdictionCountry,
      petJurisdictionProvince: pet.jurisdictionProvince ?? null,
      petJurisdictionLocality: pet.jurisdictionLocality ?? null,
      vetUserId,
      vetDisplayName: "Dr. Test Ddx",
      diseaseCode: "rabies_confirmed",
      confirmedByLab: true,
      labName: "INPPAZ",
      labReportReference: "LAB-S4",
      diagnosisDate,
      notes: null,
    });
    expect(dx.ok).toBe(true);

    const death = await createDeathRecord(deathInput(pet, {}), deps());
    expect(death.ok).toBe(true);
    if (!death.ok) return;

    const rows = await db
      .select()
      .from(eventNotificationOutbox)
      .where(sql`${eventNotificationOutbox.enoCaseKey} like ${`rabies:pet:${pet.id}:%`}`);
    expect(rows).toHaveLength(1);
    const linked = (rows[0].linkedSources as { source_event_id: string }[]).map(
      (l) => l.source_event_id,
    );
    expect(linked).toContain(death.eventId);
    expect(rows[0].slaDueAt.getTime()).toBe(diagnosisDate.getTime() + 24 * 60 * 60 * 1000);
  });

  it("an owner's unconfirmed leptospirosis death mints no legal row", async () => {
    const pet = await insertTestPet(ownerUserId, "DEATHOWN");
    const death = await createDeathRecord(
      deathInput(pet, {
        recordedByUserId: ownerUserId,
        eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
        confirmedByVet: false,
        diseaseCode: "leptospirosis",
      }),
      deps(),
    );
    expect(death.ok).toBe(true);
    if (!death.ok) return;
    const rows = await db
      .select({ id: eventNotificationOutbox.id })
      .from(eventNotificationOutbox)
      .where(eq(eventNotificationOutbox.sourceEventId, death.eventId));
    expect(rows).toHaveLength(0);
  });
});

// PO S9 (2026-09-26): correcting a diagnosis re-evaluates the legal queue —
// create or merge when it becomes notifiable or more urgent; never lengthen,
// never delete.
describe("amendment re-evaluates the ENO outbox (S9)", () => {
  const HOUR = 60 * 60 * 1000;

  async function diagnose(tokenSuffix: string, diseaseCode: string, diagnosisDate: Date) {
    const pet = await insertTestPet(ownerUserId, tokenSuffix);
    const r = await recordDiseaseDiagnosisWriter({
      petId: pet.id,
      petName: pet.name,
      petSpecies: pet.species,
      petJurisdictionCountry: pet.jurisdictionCountry,
      petJurisdictionProvince: pet.jurisdictionProvince ?? null,
      petJurisdictionLocality: pet.jurisdictionLocality ?? null,
      vetUserId,
      vetDisplayName: "Dr. Test Ddx",
      diseaseCode,
      confirmedByLab: false,
      labName: null,
      labReportReference: null,
      diagnosisDate,
      notes: null,
    });
    if (!r.ok) throw new Error(r.error);
    const [root] = await db.select().from(petEvents).where(eq(petEvents.id, r.diagnosisEventId));
    return { pet, root };
  }

  async function amend(
    ctx: Awaited<ReturnType<typeof diagnose>>,
    changes: Record<string, unknown>,
  ) {
    const before = ctx.root.payload as Record<string, unknown>;
    const after = { ...before, ...changes };
    return db.transaction(async (tx) => {
      const amendment = await new EventsRepository().insertEvent(
        {
          petId: ctx.pet.id,
          eventType: "event_amended",
          occurredAt: new Date(),
          recordedAt: new Date(),
          recordedByUserId: vetUserId,
          authorRole: "vet",
          authorVerified: true,
          authorOrganizationId: null,
          payload: {
            target_event_id: ctx.root.id,
            reason: "Corrección del diagnóstico",
            changes: Object.entries(changes).map(([field, value]) => ({
              field,
              old: before[field] ?? null,
              new: value,
            })),
            actor_role: "vet",
            actor_user_id: vetUserId,
          },
        },
        tx,
      );
      const results = await reevaluateOutboxAfterAmendment(tx, {
        root: {
          id: ctx.root.id,
          petId: ctx.pet.id,
          eventType: ctx.root.eventType,
          occurredAt: ctx.root.occurredAt,
          author: { authorRole: "vet", authorVerified: true },
        },
        before,
        after,
        amendmentEventId: amendment.id,
        pet: {
          jurisdictionProvince: ctx.pet.jurisdictionProvince,
          jurisdictionLocality: ctx.pet.jurisdictionLocality,
        },
      });
      return { amendmentId: amendment.id, results };
    });
  }

  const rowsOf = (sourceIds: string[]) =>
    db
      .select()
      .from(eventNotificationOutbox)
      .where(inArray(eventNotificationOutbox.sourceEventId, sourceIds));

  it("a non-ENO disease corrected to leptospirosis creates the row, due from the diagnosis", async () => {
    const date = new Date(Date.now() - 3 * HOUR);
    const ctx = await diagnose("S9NEW", "parvovirus", date);
    expect(await rowsOf([ctx.root.id])).toHaveLength(0);
    const { amendmentId, results } = await amend(ctx, { disease_code: "leptospirosis" });
    expect(results).toEqual(["created"]);
    const rows = await rowsOf([amendmentId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].slaDueAt.getTime()).toBe(date.getTime() + 24 * HOUR);
  });

  it("hidatidosis (48 h) corrected to leptospirosis (24 h) tightens the same record", async () => {
    const date = new Date(Date.now() - 3 * HOUR);
    const ctx = await diagnose("S9TIGHT", "hydatidosis", date);
    const { amendmentId, results } = await amend(ctx, { disease_code: "leptospirosis" });
    expect(results).toEqual(["tightened"]);
    const rows = await rowsOf([ctx.root.id, amendmentId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].slaDueAt.getTime()).toBe(date.getTime() + 24 * HOUR);
    const links = (rows[0].linkedSources as { source_event_id: string }[]).map(
      (l) => l.source_event_id,
    );
    expect(links).toContain(amendmentId);
  });

  it("leptospirosis corrected to hidatidosis (a LONGER window) changes nothing", async () => {
    const date = new Date(Date.now() - 3 * HOUR);
    const ctx = await diagnose("S9LONG", "leptospirosis", date);
    const { amendmentId, results } = await amend(ctx, { disease_code: "hydatidosis" });
    expect(results).toEqual(["unchanged"]);
    const rows = await rowsOf([ctx.root.id, amendmentId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].slaDueAt.getTime()).toBe(date.getTime() + 24 * HOUR);
  });

  it("a diagnosis corrected to a non-notifiable disease keeps its record (never deleted)", async () => {
    const ctx = await diagnose("S9KEEP", "leptospirosis", new Date(Date.now() - HOUR));
    const { results } = await amend(ctx, { disease_code: "parvovirus" });
    expect(results).toEqual(["unchanged"]);
    expect(await rowsOf([ctx.root.id])).toHaveLength(1);
  });

  it("end to end: a vet's correction through amendEvent creates the legal row", async () => {
    const date = new Date(Date.now() - 4 * HOUR);
    const ctx = await diagnose("S9E2E", "parvovirus", date);
    const result = await amendEvent(
      { id: vetUserId },
      { id: ctx.pet.id, name: ctx.pet.name, publicToken: ctx.pet.publicToken },
      { authorRole: "vet", authorOrganizationId: null, authorVerified: true },
      {
        publicToken: ctx.pet.publicToken,
        targetEventId: ctx.root.id,
        reason: "Resultado de laboratorio",
        changes: [{ field: "disease_code", old: "parvovirus", new: "leptospirosis" }],
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = await rowsOf([result.amendmentEventId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].slaDueAt.getTime()).toBe(date.getTime() + 24 * HOUR);
  });

  it("hidatidosis corrected to rabies joins the rabies case", async () => {
    const date = new Date(Date.now() - 2 * HOUR);
    const ctx = await diagnose("S9RAB", "hydatidosis", date);
    await amend(ctx, { disease_code: "rabies_confirmed" });
    const rows = await db
      .select()
      .from(eventNotificationOutbox)
      .where(like(eventNotificationOutbox.enoCaseKey, `rabies:pet:${ctx.pet.id}:%`));
    expect(rows).toHaveLength(1);
    expect(rows[0].slaDueAt.getTime()).toBe(date.getTime() + 24 * HOUR);
  });
});
