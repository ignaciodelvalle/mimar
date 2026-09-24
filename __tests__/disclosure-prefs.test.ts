// Integration tests for Lost & Found Fase 3 — owner disclosure preferences.
//
// Structure:
//   1. Unit tests — parseDisclosurePrefsFromForm equivalent (via setPetLostWriter)
//   2. Integration tests — setPetLostWriter persists prefs to pets row
//   3. Integration tests — setPetLostWriter writes snapshot to event payload
//   4. Integration tests — re-submit (already-lost pet guard) does not clobber row
//   5. Integration tests — old form submission without section preserves pet defaults

import { createClient } from "@supabase/supabase-js";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, petEvents, pets, profiles } from "@/db";
import { generatePublicToken } from "@/lib/infra/publicToken";
import type { DisclosurePrefsInput } from "@/src/modules/events/actions";
import { setPetLostWriter } from "@/src/modules/events/application/writers";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabase = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER_EMAIL = "disclosure-prefs-owner@dim-test.local";
const PASS = "DisclosurePrefs_2026!";

let ownerUserId: string;

// Pet IDs inserted during tests — tracked for afterAll cleanup.
const insertedPetIds: string[] = [];

// ---------------------------------------------------------------------------
// Cleanup helper
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
  for (const uid of ids) {
    // Cases system (Fase D3): cases.opened_by_user_id and
    // closed_by_user_id reference profiles with RESTRICT semantics in
    // migration 0033 — null them out before deleting the profile.
    // Also break pet_events.recorded_by_user_id (cascade SET NULL would
    // UPDATE pet_events and hit the append-only guard).
    await withMutationOverride(async (tx) => {
      await tx.execute(
        sql`UPDATE pet_events SET recorded_by_user_id = NULL WHERE recorded_by_user_id = ${uid}`,
      );
      await tx.execute(
        sql`UPDATE cases SET opened_by_user_id = NULL WHERE opened_by_user_id = ${uid}`,
      );
      await tx.execute(
        sql`UPDATE cases SET closed_by_user_id = NULL WHERE closed_by_user_id = ${uid}`,
      );
    });
    await db.delete(profiles).where(eq(profiles.id, uid));
  }
  if (found) await supabase.auth.admin.deleteUser(found.id);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await purgeUserByEmail(OWNER_EMAIL);

  const o = await createFreshTestUser(supabase, {
    email: OWNER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (o.error || !o.data.user) throw new Error(`createUser owner: ${o.error?.message}`);
  ownerUserId = o.data.user.id;
});

afterAll(async () => {
  for (const petId of insertedPetIds) {
    await withMutationOverride(async (tx) => {
      // Cases system (Fase D3): setPetLostWriter opens a lost_pet_episode
      // case. pet_events.case_id RESTRICTs cases deletion → wipe events
      // first, then the case row, then the pet.
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}`);
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${petId}`);
      await tx.delete(pets).where(eq(pets.id, petId));
    });
  }
  await purgeUserByEmail(OWNER_EMAIL);
});

// ---------------------------------------------------------------------------
// Helper: insert an active pet with owner ownership.
// ---------------------------------------------------------------------------

async function insertActivePet(suffix: string): Promise<{ petId: string; publicToken: string }> {
  const token = generatePublicToken();
  const now = new Date();

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: `TestPet-${suffix}`,
      species: "dog",
      sex: "unknown",
      status: "active",
      potentiallyDangerousBreed: false,
    })
    .returning();

  await db.insert(ownerships).values({
    petId: pet.id,
    ownerUserId,
    role: "owner",
    startedAt: now,
  });

  insertedPetIds.push(pet.id);
  return { petId: pet.id, publicToken: token };
}

// Default disclosure prefs matching schema defaults.
const defaultPrefs: DisclosurePrefsInput = {
  discloseFirstNameWhenLost: true,
  disclosePhoneWhenLost: true,
  discloseEmailWhenLost: false,
  discloseLastLocationWhenLost: true,
  allowFinderFormWhenLost: true,
};

// ---------------------------------------------------------------------------
// Unit tests — writer guards
// ---------------------------------------------------------------------------

describe("setPetLostWriter — status guards", () => {
  it("returns error when pet is already lost", async () => {
    const result = await setPetLostWriter({
      petId: "00000000-0000-4000-8000-000000000001",
      petStatus: "lost",
      fromStatus: "lost",
      recordedByUserId: "00000000-0000-4000-8000-000000000002",
      eventAuthorship: {},
      locationDescription: null,
      locationLat: null,
      locationLng: null,
      reason: null,
      disclosurePrefs: defaultPrefs,
    });
    expect(result.error).toMatch(/ya está marcada como perdida/i);
  });

  it("returns error when pet is deceased", async () => {
    const result = await setPetLostWriter({
      petId: "00000000-0000-4000-8000-000000000001",
      petStatus: "deceased",
      fromStatus: "deceased",
      recordedByUserId: "00000000-0000-4000-8000-000000000002",
      eventAuthorship: {},
      locationDescription: null,
      locationLat: null,
      locationLng: null,
      reason: null,
      disclosurePrefs: defaultPrefs,
    });
    expect(result.error).toMatch(/fallecida/i);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — prefs written to pets row
// ---------------------------------------------------------------------------

describe("setPetLostWriter — persists disclosure prefs to pets row", () => {
  it("writes all 5 disclosure pref columns when marking as lost", async () => {
    const { petId } = await insertActivePet("prefs-write");

    const customPrefs: DisclosurePrefsInput = {
      discloseFirstNameWhenLost: true,
      disclosePhoneWhenLost: false,
      discloseEmailWhenLost: true,
      discloseLastLocationWhenLost: false,
      allowFinderFormWhenLost: true,
    };

    const result = await setPetLostWriter({
      petId,
      petStatus: "active",
      fromStatus: "active",
      recordedByUserId: ownerUserId,
      eventAuthorship: { authorRole: "owner" },
      locationDescription: "Parque Centenario",
      locationLat: null,
      locationLng: null,
      reason: null,
      disclosurePrefs: customPrefs,
    });

    expect(result.error).toBeNull();

    const [updated] = await db.select().from(pets).where(eq(pets.id, petId));
    expect(updated.status).toBe("lost");
    expect(updated.discloseFirstNameWhenLost).toBe(true);
    expect(updated.disclosePhoneWhenLost).toBe(false);
    expect(updated.discloseEmailWhenLost).toBe(true);
    expect(updated.discloseLastLocationWhenLost).toBe(false);
    expect(updated.allowFinderFormWhenLost).toBe(true);
  });

  it("writes default prefs when owner submits without changing toggles", async () => {
    const { petId } = await insertActivePet("prefs-defaults");

    const result = await setPetLostWriter({
      petId,
      petStatus: "active",
      fromStatus: "active",
      recordedByUserId: ownerUserId,
      eventAuthorship: { authorRole: "owner" },
      locationDescription: null,
      locationLat: null,
      locationLng: null,
      reason: null,
      disclosurePrefs: defaultPrefs,
    });

    expect(result.error).toBeNull();

    const [updated] = await db.select().from(pets).where(eq(pets.id, petId));
    expect(updated.discloseFirstNameWhenLost).toBe(true);
    expect(updated.disclosePhoneWhenLost).toBe(true);
    expect(updated.discloseEmailWhenLost).toBe(false);
    expect(updated.discloseLastLocationWhenLost).toBe(true);
    expect(updated.allowFinderFormWhenLost).toBe(true);
  });

  it("all-false prefs are written correctly (maximum privacy)", async () => {
    const { petId } = await insertActivePet("prefs-all-false");

    const allFalse: DisclosurePrefsInput = {
      discloseFirstNameWhenLost: false,
      disclosePhoneWhenLost: false,
      discloseEmailWhenLost: false,
      discloseLastLocationWhenLost: false,
      allowFinderFormWhenLost: false,
    };

    const result = await setPetLostWriter({
      petId,
      petStatus: "active",
      fromStatus: "active",
      recordedByUserId: ownerUserId,
      eventAuthorship: { authorRole: "owner" },
      locationDescription: null,
      locationLat: null,
      locationLng: null,
      reason: null,
      disclosurePrefs: allFalse,
    });

    expect(result.error).toBeNull();

    const [updated] = await db.select().from(pets).where(eq(pets.id, petId));
    expect(updated.discloseFirstNameWhenLost).toBe(false);
    expect(updated.disclosePhoneWhenLost).toBe(false);
    expect(updated.discloseEmailWhenLost).toBe(false);
    expect(updated.discloseLastLocationWhenLost).toBe(false);
    expect(updated.allowFinderFormWhenLost).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — snapshot written to event payload
// ---------------------------------------------------------------------------

describe("setPetLostWriter — writes disclosure_prefs_snapshot to event payload", () => {
  it("snapshot in status_changed event matches the submitted prefs", async () => {
    const { petId } = await insertActivePet("snapshot-match");

    const prefs: DisclosurePrefsInput = {
      discloseFirstNameWhenLost: true,
      disclosePhoneWhenLost: false,
      discloseEmailWhenLost: true,
      discloseLastLocationWhenLost: true,
      allowFinderFormWhenLost: false,
    };

    await setPetLostWriter({
      petId,
      petStatus: "active",
      fromStatus: "active",
      recordedByUserId: ownerUserId,
      eventAuthorship: { authorRole: "owner" },
      locationDescription: "Av. Corrientes 1234",
      locationLat: null,
      locationLng: null,
      reason: "Se escapó del jardín",
      disclosurePrefs: prefs,
    });

    const [event] = await db
      .select({ payload: petEvents.payload })
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, petId),
          eq(petEvents.eventType, "status_changed"),
          sql`${petEvents.payload}->>'to_status' = 'lost'`,
        ),
      )
      .orderBy(desc(petEvents.occurredAt))
      .limit(1);

    expect(event).toBeDefined();
    const payload = event.payload as Record<string, unknown>;

    expect(payload.to_status).toBe("lost");
    expect(payload.location_description).toBe("Av. Corrientes 1234");

    const snapshot = payload.disclosure_prefs_snapshot as Record<string, boolean>;
    expect(snapshot).toBeDefined();
    expect(snapshot.first_name).toBe(true);
    expect(snapshot.phone).toBe(false);
    expect(snapshot.email).toBe(true);
    expect(snapshot.last_location).toBe(true);
    expect(snapshot.finder_form).toBe(false);
  });

  it("snapshot is present even when locationDescription is null", async () => {
    const { petId } = await insertActivePet("snapshot-no-location");

    await setPetLostWriter({
      petId,
      petStatus: "active",
      fromStatus: "active",
      recordedByUserId: ownerUserId,
      eventAuthorship: { authorRole: "owner" },
      locationDescription: null,
      locationLat: null,
      locationLng: null,
      reason: null,
      disclosurePrefs: defaultPrefs,
    });

    const [event] = await db
      .select({ payload: petEvents.payload })
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, petId),
          eq(petEvents.eventType, "status_changed"),
          sql`${petEvents.payload}->>'to_status' = 'lost'`,
        ),
      )
      .orderBy(desc(petEvents.occurredAt))
      .limit(1);

    expect(event).toBeDefined();
    const payload = event.payload as Record<string, unknown>;
    const snapshot = payload.disclosure_prefs_snapshot as Record<string, boolean>;
    expect(snapshot).toBeDefined();
    expect(typeof snapshot.first_name).toBe("boolean");
    expect(typeof snapshot.finder_form).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// Integration tests — snapshot is audit trail (pets row is live source of truth)
// ---------------------------------------------------------------------------

describe("setPetLostWriter — pets row is live source of truth, snapshot is audit", () => {
  it("updating pets prefs directly does not change the existing event snapshot", async () => {
    const { petId } = await insertActivePet("snapshot-audit");

    const initialPrefs: DisclosurePrefsInput = {
      discloseFirstNameWhenLost: true,
      disclosePhoneWhenLost: true,
      discloseEmailWhenLost: false,
      discloseLastLocationWhenLost: true,
      allowFinderFormWhenLost: true,
    };

    await setPetLostWriter({
      petId,
      petStatus: "active",
      fromStatus: "active",
      recordedByUserId: ownerUserId,
      eventAuthorship: { authorRole: "owner" },
      locationDescription: null,
      locationLat: null,
      locationLng: null,
      reason: null,
      disclosurePrefs: initialPrefs,
    });

    // Simulate owner editing prefs while lost — directly update the pets row.
    await db
      .update(pets)
      .set({
        disclosePhoneWhenLost: false,
        discloseEmailWhenLost: true,
        updatedAt: new Date(),
      })
      .where(eq(pets.id, petId));

    // The live pets row reflects the new prefs.
    const [liveRow] = await db.select().from(pets).where(eq(pets.id, petId));
    expect(liveRow.disclosePhoneWhenLost).toBe(false);
    expect(liveRow.discloseEmailWhenLost).toBe(true);

    // But the original event snapshot still holds the at-lost-time values.
    const [event] = await db
      .select({ payload: petEvents.payload })
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, petId),
          eq(petEvents.eventType, "status_changed"),
          sql`${petEvents.payload}->>'to_status' = 'lost'`,
        ),
      )
      .orderBy(desc(petEvents.occurredAt))
      .limit(1);

    const snapshot = (event.payload as Record<string, unknown>).disclosure_prefs_snapshot as Record<
      string,
      boolean
    >;
    // Snapshot should still show original values at lost-time.
    expect(snapshot.phone).toBe(true);
    expect(snapshot.email).toBe(false);
  });
});
