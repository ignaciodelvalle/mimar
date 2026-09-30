// Integration tests for the symptom → disease surveillance pipeline.
//
// Covers:
//   1. Vague symptoms → no alerts, no outbreak_signal, no notifications
//   2. Rabies-specific symptoms → symptom_observed + outbreak_signal + notification to admin
//   3. Matcher failure (mocked) → symptom_observed still inserted, no signals
//   4. Non-reportable disease match (distemper) → no outbreak_signal emitted
//
// Auth bypass: uses createSymptomObservedWriter directly (same pattern as
// setPetLostWriter in lost-pet-broadcast.test.ts / confirmChipMatchAsWriter
// in chip-match.test.ts) to avoid the Next.js request context requirement.

import { createClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, notifications, ownerships, petEvents, pets, profiles } from "@/db";
import { fetchSurveillanceSignals } from "@/lib/analytics/dashboards/surveillance";
import { createSymptomObservedWriter } from "@/src/modules/events/application/writers";
import {
  ADMIN_FALLBACK_JURISDICTION,
  assertAdminFallbackAvailable,
} from "./_helpers/admin-fallback-jurisdiction";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabase = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// Test fixture emails
// ---------------------------------------------------------------------------

const OWNER_EMAIL = "surveillance-owner@dim-test.local";
const ADMIN_EMAIL = "surveillance-admin@dim-test.local";
const PASS = "Surveillance_2026!";

let ownerUserId: string;
let adminUserId: string;

const insertedPetIds: string[] = [];

// This suite covers the ADMIN-FALLBACK path — "no govt seeded for this
// locality" — so it needs a jurisdiction no govt operator holds.
//
// THE JURISDICTION AND THE REASON BOTH MOVED TO A SHARED HELPER (2026-08-26).
// `role-upgrade.test.ts` depends on the identical premise and used to carry its
// own copy of this paragraph and its own `"Mendoza"` / `"Bowen"` literals — two
// files silently coupled through the database, each free to drift onto a
// different locality and lose the reason the other picked it.
//
// More importantly the premise is now CHECKED rather than hoped for. It broke
// twice: once when the demo seed gave Lucas the whole East region, and once when
// a whole-province Mendoza fixture leaked out of `admin-decisions.test.ts` after
// a worker died before its teardown. The second time cost three assertions
// across two files, failing together for days as "flakes", because the symptom
// — `expected 0 to be greater than or equal to 1` on a notification count —
// names nothing that would lead anyone to a row left behind by another file.
const { province: TEST_PROVINCE, locality: TEST_LOCALITY } = ADMIN_FALLBACK_JURISDICTION;

// ---------------------------------------------------------------------------
// Cleanup helpers
// ---------------------------------------------------------------------------

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
  await withMutationOverride(async (tx) => {
    for (const uid of ids) {
      await tx.delete(notifications).where(eq(notifications.userId, uid));
      await tx.delete(profiles).where(eq(profiles.id, uid));
    }
  });
  if (found) await supabase.auth.admin.deleteUser(found.id);
}

async function insertTestPet(ownerUid: string, tokenSuffix: string) {
  const token = `SURVTEST-${tokenSuffix}-${Date.now()}`;
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: `Surveillance Pet ${tokenSuffix}`,
      species: "dog",
      sex: "female",
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

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // The premise, checked before anything is built on it. Without this, a govt
  // assignment covering Mendoza/Bowen — usually one leaked by another file —
  // turns the rabies assertion below into a bare "expected 0", which names
  // neither the cause nor the file that caused it.
  await assertAdminFallbackAvailable();

  await purgeUserByEmail(OWNER_EMAIL);
  await purgeUserByEmail(ADMIN_EMAIL);

  const o = await createFreshTestUser(supabase, {
    email: OWNER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (o.error || !o.data.user) throw new Error(`createUser owner: ${o.error?.message}`);
  ownerUserId = o.data.user.id;

  const a = await createFreshTestUser(supabase, {
    email: ADMIN_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (a.error || !a.data.user) throw new Error(`createUser admin: ${a.error?.message}`);
  adminUserId = a.data.user.id;

  // Mark admin user as institutional admin in profiles.
  // account_type='institutional' is required by profiles_account_type_role_match
  // CHECK (migration 0015) whenever role='admin' or role='govt'.
  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional" })
    .where(eq(profiles.id, adminUserId));
});

afterAll(async () => {
  // Delete tracked pets (cascade removes ownerships and pet_events).
  for (const petId of insertedPetIds) {
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, petId));
    });
  }

  // Clean up notifications for test users.
  for (const uid of [ownerUserId, adminUserId].filter(Boolean)) {
    await db.delete(notifications).where(eq(notifications.userId, uid));
  }

  await purgeUserByEmail(OWNER_EMAIL);
  await purgeUserByEmail(ADMIN_EMAIL);
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const ownerAuthorship = {
  authorRole: "owner" as const,
  authorOrganizationId: null,
  authorVerified: false,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSymptomObservedWriter — surveillance pipeline", () => {
  it("vague symptoms produce no alerts, no outbreak_signal, no notification", async () => {
    const pet = await insertTestPet(ownerUserId, "VAGUE");

    const result = await createSymptomObservedWriter({
      petId: pet.id,
      petPublicToken: pet.publicToken,
      petName: pet.name,
      petSpecies: pet.species,
      petJurisdictionCountry: pet.jurisdictionCountry,
      petJurisdictionProvince: pet.jurisdictionProvince ?? null,
      petJurisdictionLocality: pet.jurisdictionLocality ?? null,
      recordedByUserId: ownerUserId,
      eventAuthorship: ownerAuthorship,
      freeText: "está cansado",
      severity: null,
      onsetAt: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");

    // symptom_observed must be inserted.
    const symptomEvents = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "symptom_observed")));
    expect(symptomEvents).toHaveLength(1);
    const payload = symptomEvents[0].payload as Record<string, unknown>;
    expect(payload.alerted_disease_codes).toEqual([]);

    // No outbreak_signal emitted.
    const signals = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "outbreak_signal")));
    expect(signals).toHaveLength(0);

    // No notification sent.
    const notifs = await db
      .select()
      .from(notifications)
      .where(eq(notifications.relatedPetId, pet.id));
    expect(notifs).toHaveLength(0);
  });

  it("rabies symptoms → symptom_observed + outbreak_signal + notification to authority (admin fallback — no govt seeded for test locality)", async () => {
    const pet = await insertTestPet(ownerUserId, "RABIES");

    const result = await createSymptomObservedWriter({
      petId: pet.id,
      petPublicToken: pet.publicToken,
      petName: pet.name,
      petSpecies: pet.species,
      petJurisdictionCountry: pet.jurisdictionCountry,
      petJurisdictionProvince: pet.jurisdictionProvince ?? null,
      petJurisdictionLocality: pet.jurisdictionLocality ?? null,
      recordedByUserId: ownerUserId,
      eventAuthorship: ownerAuthorship,
      freeText: "le sale baba y está muy agresivo",
      severity: "moderate",
      onsetAt: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.error}`);

    // symptom_observed with rabies_suspected in alerted_disease_codes.
    const symptomEvents = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "symptom_observed")));
    expect(symptomEvents).toHaveLength(1);
    const symPayload = symptomEvents[0].payload as Record<string, unknown>;
    expect(symPayload.alerted_disease_codes as string[]).toContain("rabies_suspected");
    expect(symPayload.free_text).toBe("le sale baba y está muy agresivo");

    // outbreak_signal emitted with disease_code='rabies_suspected' and authorRole='system'.
    const signals = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "outbreak_signal")));
    expect(signals.length).toBeGreaterThanOrEqual(1);
    const rabiesSignal = signals.find((s) => {
      const p = s.payload as Record<string, unknown>;
      return p.disease_code === "rabies_suspected";
    });
    expect(rabiesSignal).toBeDefined();
    expect(rabiesSignal!.authorRole).toBe("system");

    // outbreak_signal.relatedEventId links back to symptom_observed.
    const signalPayload = rabiesSignal!.payload as Record<string, unknown>;
    expect(signalPayload.source_symptom_event_id).toBe(result.symptomEventId);

    // Notification sent to admin with severity='warning'.
    const notifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, adminUserId),
          eq(notifications.notificationType, "outbreak_signal_detected"),
          eq(notifications.relatedPetId, pet.id),
        ),
      );
    expect(notifs.length).toBeGreaterThanOrEqual(1);
    expect(notifs[0].severity).toBe("warning");
    expect(notifs[0].title).toContain("Sospecha de rabia");
    // relatedEventId points at the outbreak_signal event.
    expect(notifs[0].relatedEventId).toBe(rabiesSignal!.id);
  });

  it("a vet-reported symptom signal tells the authority a vet observed it, not the owner", async () => {
    const pet = await insertTestPet(ownerUserId, "VETREP");

    const result = await createSymptomObservedWriter({
      petId: pet.id,
      petPublicToken: pet.publicToken,
      petName: pet.name,
      petSpecies: pet.species,
      petJurisdictionCountry: pet.jurisdictionCountry,
      petJurisdictionProvince: pet.jurisdictionProvince ?? null,
      petJurisdictionLocality: pet.jurisdictionLocality ?? null,
      recordedByUserId: adminUserId,
      eventAuthorship: { authorRole: "vet", authorOrganizationId: null, authorVerified: true },
      freeText: "le sale baba y está muy agresivo",
      severity: null,
      onsetAt: null,
      reporterRole: "vet",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.error}`);

    const [signal] = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "outbreak_signal")));
    expect((signal.payload as Record<string, unknown>).reporter_role).toBe("vet");

    const notifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, adminUserId),
          eq(notifications.notificationType, "outbreak_signal_detected"),
          eq(notifications.relatedPetId, pet.id),
        ),
      );
    expect(notifs).toHaveLength(1);
    expect(notifs[0].body).toContain("Síntomas observados por un veterinario en la consulta");
    expect(notifs[0].body).not.toContain("quien cuida al animal");
  });

  describe("one episode, two reporters — corroboration instead of a second signal", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const RABIES_TEXT = "le sale baba y está muy agresivo";

    function report(
      pet: typeof pets.$inferSelect,
      who: "owner" | "vet",
      now: Date,
    ): ReturnType<typeof createSymptomObservedWriter> {
      return createSymptomObservedWriter({
        petId: pet.id,
        petPublicToken: pet.publicToken,
        petName: pet.name,
        petSpecies: pet.species,
        petJurisdictionCountry: pet.jurisdictionCountry,
        petJurisdictionProvince: pet.jurisdictionProvince ?? null,
        petJurisdictionLocality: pet.jurisdictionLocality ?? null,
        recordedByUserId: who === "owner" ? ownerUserId : adminUserId,
        eventAuthorship:
          who === "owner"
            ? ownerAuthorship
            : { authorRole: "vet", authorOrganizationId: null, authorVerified: true },
        freeText: RABIES_TEXT,
        severity: null,
        onsetAt: null,
        // The vet leg is exactly what recordConditionAtIntake passes
        // (condition-at-intake-use-case.ts): reporterRole 'vet' + its own now.
        reporterRole: who,
        now,
      });
    }

    async function rabiesSignals(petId: string) {
      const rows = await db
        .select()
        .from(petEvents)
        .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "outbreak_signal")));
      return rows.filter(
        (r) => (r.payload as Record<string, unknown>).disease_code === "rabies_suspected",
      );
    }

    async function authorityNotices(petId: string) {
      return db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, adminUserId),
            eq(notifications.notificationType, "outbreak_signal_detected"),
            eq(notifications.relatedPetId, petId),
          ),
        );
    }

    /** What the /gob/vigilancia list and 30-day tile count for this pet. */
    async function kpiCountedSignals(petId: string) {
      const rows = await fetchSurveillanceSignals({ role: "admin" }, [], {
        since: new Date(Date.now() - 30 * DAY_MS),
        diseaseCode: "rabies_suspected",
      });
      return rows.filter((r) => r.petId === petId);
    }

    it("owner report then vet intake inside the window: ONE signal, ONE notice, ONE KPI row, corroboration recorded", async () => {
      const pet = await insertTestPet(ownerUserId, "CORROB");

      const owner = await report(pet, "owner", new Date(Date.now() - 2 * DAY_MS));
      if (!owner.ok) throw new Error(owner.error);
      expect(owner.signalEventIds).toHaveLength(1);

      const vet = await report(pet, "vet", new Date());
      if (!vet.ok) throw new Error(vet.error);
      expect(vet.signalEventIds).toEqual([]);
      expect(vet.corroboratedSignalEventIds).toEqual(owner.signalEventIds);

      const signals = await rabiesSignals(pet.id);
      expect(signals.map((s) => s.id)).toEqual(owner.signalEventIds);
      expect(await authorityNotices(pet.id)).toHaveLength(1);
      expect((await kpiCountedSignals(pet.id)).map((s) => s.signalEventId)).toEqual(
        owner.signalEventIds,
      );

      // The corroboration lives on the vet's symptom_observed; the owner's
      // signal is untouched (append-only).
      const [vetSymptom] = await db
        .select()
        .from(petEvents)
        .where(eq(petEvents.id, vet.symptomEventId));
      expect((vetSymptom.payload as Record<string, unknown>).corroborated_signals).toEqual([
        { disease_code: "rabies_suspected", outbreak_signal_event_id: owner.signalEventIds[0] },
      ]);
      expect((vetSymptom.payload as Record<string, unknown>).reporter_role).toBe("vet");
      expect((signals[0].payload as Record<string, unknown>).reporter_role).toBe("owner");
    });

    it("outside the 30-day window the vet intake raises its own signal", async () => {
      const pet = await insertTestPet(ownerUserId, "NOCORROB");

      const owner = await report(pet, "owner", new Date(Date.now() - 31 * DAY_MS));
      if (!owner.ok) throw new Error(owner.error);
      const vet = await report(pet, "vet", new Date());
      if (!vet.ok) throw new Error(vet.error);

      expect(vet.signalEventIds).toHaveLength(1);
      expect(vet.corroboratedSignalEventIds).toEqual([]);
      expect(await rabiesSignals(pet.id)).toHaveLength(2);
      expect(await authorityNotices(pet.id)).toHaveLength(2);

      const [vetSymptom] = await db
        .select()
        .from(petEvents)
        .where(eq(petEvents.id, vet.symptomEventId));
      expect(vetSymptom.payload as Record<string, unknown>).not.toHaveProperty(
        "corroborated_signals",
      );
    });
  });

  it("non-reportable disease match (distemper via cough+nasal_discharge) → no outbreak_signal", async () => {
    // distemper: nasal_discharge is high, cough is medium — triggers_alert but NOT reportable.
    const pet = await insertTestPet(ownerUserId, "DISTEMPER");

    const result = await createSymptomObservedWriter({
      petId: pet.id,
      petPublicToken: pet.publicToken,
      petName: pet.name,
      petSpecies: pet.species,
      petJurisdictionCountry: pet.jurisdictionCountry,
      petJurisdictionProvince: pet.jurisdictionProvince ?? null,
      petJurisdictionLocality: pet.jurisdictionLocality ?? null,
      recordedByUserId: ownerUserId,
      eventAuthorship: ownerAuthorship,
      freeText: "tose mucho y le sale moco por la nariz",
      severity: null,
      onsetAt: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Expected ok, got: ${result.error}`);

    // symptom_observed present, no distemper in alerted_disease_codes (not reportable).
    const symptomEvents = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "symptom_observed")));
    expect(symptomEvents).toHaveLength(1);
    const p = symptomEvents[0].payload as Record<string, unknown>;
    expect((p.alerted_disease_codes as string[]).includes("distemper")).toBe(false);

    // No outbreak_signal for distemper.
    const signals = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "outbreak_signal")));
    const distemperSignal = signals.find((s) => {
      const sp = s.payload as Record<string, unknown>;
      return sp.disease_code === "distemper";
    });
    expect(distemperSignal).toBeUndefined();
  });
});
