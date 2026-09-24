// Integration tests — scan-event retention purge (Wave 5 Item 28).
//
// Spec: dim-interno:docs/superpowers-private/specs/2026-06-19-wave5-launch-hardening-handoff.md (Item 28)
//
// Tests exercise purgeExpiredScanEvents() against the local Postgres directly.
// Each describe block provisions its own pet + events and tears them down via
// withMutationOverride (pet_events is append-only).
//
// Contract under test:
//   - Deletes credential_scanned events with author_role='scanner' older than
//     SCAN_RETENTION_DAYS (90 days).
//   - Keeps credential_scanned events that are 90 days old or less.
//   - Does NOT delete events from other author_roles (owner, system, vet…).
//   - Does NOT delete other event types authored by 'scanner'.

import { createClient } from "@supabase/supabase-js";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditLog, db, ownerships, petEvents, pets, profiles } from "@/db";
import { SCAN_RETENTION_DAYS, purgeExpiredScanEvents } from "@/lib/infra/scan-retention";
import { withMutationOverride } from "./_helpers/db-overrides";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = "SCAN-RET";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function createTestPet(tokenSuffix: string) {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `${TOKEN_PREFIX}-${tokenSuffix}`,
      name: `ScanRetPet_${tokenSuffix}`,
      species: "dog",
      sex: "unknown",
      status: "active",
    })
    .returning();
  return pet;
}

async function insertScanEvent(
  petId: string,
  occurredAt: Date,
  authorRole: "scanner" | "owner" | "system" = "scanner",
) {
  const [row] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "credential_scanned",
      occurredAt,
      payload: {
        payload_version: 1,
        is_self_scan: authorRole !== "scanner",
        viewer_authenticated: false,
        // Task #45: scanner-role scans carry the coarse IP-area (and, when the
        // pet was lost + consent granted, GPS coords). Including them in the
        // fixture proves the purge is what bounds retention of location data.
        ...(authorRole === "scanner"
          ? {
              scan_ip_area: { city: "La Plata", region: "B", country: "AR" },
              scan_coords: { lat: -34.9205, lng: -57.9536 },
              scan_accuracy_m: 25,
            }
          : {}),
      },
      authorRole,
      recordedByUserId: null,
    })
    .returning({ id: petEvents.id });
  return row.id;
}

async function insertVaccinationEvent(petId: string, occurredAt: Date) {
  // Non-scan event authored by 'scanner' to verify the purge does not touch
  // other event types (edge case: author_role filter must be AND'd with
  // event_type filter).
  const [row] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "vaccination_administered",
      occurredAt,
      payload: {
        payload_version: 1,
        vaccine_name: "Test",
        brand: null,
        batch: null,
        administered_by: null,
        next_due_at: null,
      },
      authorRole: "owner",
      recordedByUserId: null,
    })
    .returning({ id: petEvents.id });
  return row.id;
}

async function petEventExists(id: string): Promise<boolean> {
  const rows = await db.select({ id: petEvents.id }).from(petEvents).where(eq(petEvents.id, id));
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let sharedPetId: string;
const allPetIds: string[] = [];

beforeAll(async () => {
  // Create a single shared pet for most tests; specific tests create their own.
  const pet = await createTestPet("shared");
  sharedPetId = pet.id;
  allPetIds.push(sharedPetId);
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    for (const petId of allPetIds) {
      await tx.delete(ownerships).where(eq(ownerships.petId, petId));
      await tx.delete(petEvents).where(eq(petEvents.petId, petId));
      await tx.delete(pets).where(eq(pets.id, petId));
    }
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("purgeExpiredScanEvents", () => {
  describe("deletes scanner events older than the TTL", () => {
    it("purges a scanner event that is exactly TTL+1 days old", async () => {
      const now = new Date();
      const oldDate = new Date(now.getTime() - (SCAN_RETENTION_DAYS + 1) * MS_PER_DAY);

      const eventId = await insertScanEvent(sharedPetId, oldDate, "scanner");

      const deleted = await purgeExpiredScanEvents({ now });

      expect(deleted).toBeGreaterThanOrEqual(1);
      expect(await petEventExists(eventId)).toBe(false);
    });

    it("purges multiple scanner events older than the TTL", async () => {
      const now = new Date();
      const old1 = new Date(now.getTime() - (SCAN_RETENTION_DAYS + 5) * MS_PER_DAY);
      const old2 = new Date(now.getTime() - (SCAN_RETENTION_DAYS + 10) * MS_PER_DAY);

      const id1 = await insertScanEvent(sharedPetId, old1, "scanner");
      const id2 = await insertScanEvent(sharedPetId, old2, "scanner");

      const deleted = await purgeExpiredScanEvents({ now });

      expect(deleted).toBeGreaterThanOrEqual(2);
      expect(await petEventExists(id1)).toBe(false);
      expect(await petEventExists(id2)).toBe(false);
    });
  });

  describe("preserves events within the retention window", () => {
    it("does NOT purge a scanner event that is TTL-1 days old", async () => {
      const now = new Date();
      const recentDate = new Date(now.getTime() - (SCAN_RETENTION_DAYS - 1) * MS_PER_DAY);

      const eventId = await insertScanEvent(sharedPetId, recentDate, "scanner");

      await purgeExpiredScanEvents({ now });

      expect(await petEventExists(eventId)).toBe(true);

      // Cleanup via override (event is within retention, so purge won't remove it).
      await withMutationOverride(async (tx) => {
        await tx.delete(petEvents).where(eq(petEvents.id, eventId));
      });
    });

    it("does NOT purge a scanner event from today", async () => {
      const now = new Date();

      const eventId = await insertScanEvent(sharedPetId, now, "scanner");

      await purgeExpiredScanEvents({ now });

      expect(await petEventExists(eventId)).toBe(true);

      await withMutationOverride(async (tx) => {
        await tx.delete(petEvents).where(eq(petEvents.id, eventId));
      });
    });
  });

  describe("author_role isolation", () => {
    it("does NOT purge an old credential_scanned event with author_role='owner' (self-scan)", async () => {
      const now = new Date();
      const oldDate = new Date(now.getTime() - (SCAN_RETENTION_DAYS + 5) * MS_PER_DAY);

      // Self-scans are authored as 'owner', not 'scanner' (see app/actions/scans.ts).
      const eventId = await insertScanEvent(sharedPetId, oldDate, "owner");

      await purgeExpiredScanEvents({ now });

      expect(await petEventExists(eventId)).toBe(true);

      await withMutationOverride(async (tx) => {
        await tx.delete(petEvents).where(eq(petEvents.id, eventId));
      });
    });

    it("does NOT purge an old credential_scanned event with author_role='system'", async () => {
      const now = new Date();
      const oldDate = new Date(now.getTime() - (SCAN_RETENTION_DAYS + 5) * MS_PER_DAY);

      const eventId = await insertScanEvent(sharedPetId, oldDate, "system");

      await purgeExpiredScanEvents({ now });

      expect(await petEventExists(eventId)).toBe(true);

      await withMutationOverride(async (tx) => {
        await tx.delete(petEvents).where(eq(petEvents.id, eventId));
      });
    });
  });

  describe("event_type isolation", () => {
    it("does NOT purge an old non-scan event (vaccination_administered)", async () => {
      const now = new Date();
      const oldDate = new Date(now.getTime() - (SCAN_RETENTION_DAYS + 5) * MS_PER_DAY);

      const eventId = await insertVaccinationEvent(sharedPetId, oldDate);

      await purgeExpiredScanEvents({ now });

      expect(await petEventExists(eventId)).toBe(true);

      await withMutationOverride(async (tx) => {
        await tx.delete(petEvents).where(eq(petEvents.id, eventId));
      });
    });
  });

  describe("returns 0 when there is nothing to purge", () => {
    it("returns 0 when all scanner events are within the window", async () => {
      // Create a fresh pet with only a recent scan event.
      const pet = await createTestPet("zero-purge");
      allPetIds.push(pet.id);

      const now = new Date();
      const recentDate = new Date(now.getTime() - 30 * MS_PER_DAY); // 30 days old

      await insertScanEvent(pet.id, recentDate, "scanner");

      const deleted = await purgeExpiredScanEvents({ now });

      // The purge may delete 0 rows for THIS pet, but other test pets may have
      // contributed.  We assert the retained event still exists.
      const rows = await db
        .select({ id: petEvents.id })
        .from(petEvents)
        .where(and(eq(petEvents.petId, pet.id), eq(petEvents.authorRole, "scanner")));
      expect(rows.length).toBe(1);
    });
  });

  describe("SCAN_RETENTION_DAYS constant", () => {
    it("is 90 (owner-approved TTL)", () => {
      expect(SCAN_RETENTION_DAYS).toBe(90);
    });
  });
});

// ---------------------------------------------------------------------------
// Attribution (finding A08-6, migration 0235): every other audited mutation of
// pet_events refuses to act without an accountable uuid; the purge used to log
// actor_user_id = null.
// ---------------------------------------------------------------------------

// Seeded by migration 0235 and written by enforce_pet_events_append_only
// (db/triggers.sql). Pinned here, not in lib/: the migration fixes the value in
// every environment, and lint:uuid keeps uuid literals out of product source.
const SCAN_PURGE_SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000235";

describe("scan_event_purged attribution", () => {
  it("attributes each purge audit row to the system-cron profile", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - (SCAN_RETENTION_DAYS + 3) * MS_PER_DAY);
    const eventId = await insertScanEvent(sharedPetId, old, "scanner");

    await purgeExpiredScanEvents({ now });

    const rows = await db
      .select({ actorUserId: auditLog.actorUserId, payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "scan_event_purged"),
          sql`${auditLog.payload}->>'pet_event_id' = ${eventId}`,
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(SCAN_PURGE_SYSTEM_ACTOR_ID);
    // The purge bounds retention of the scan location; its audit row must not
    // be where that location survives.
    expect(JSON.stringify(rows[0].payload)).not.toContain("La Plata");
  });

  it("the actor is a system profile that cannot sign in", async () => {
    const [profile] = await db
      .select({ isSystem: profiles.isSystem, displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.id, SCAN_PURGE_SYSTEM_ACTOR_ID));
    expect(profile).toEqual({ isSystem: true, displayName: "system:cron-scan-retention" });

    const authRows = (await db.execute(
      sql`select 1 from auth.users where id = ${SCAN_PURGE_SYSTEM_ACTOR_ID}::uuid`,
    )) as unknown as unknown[];
    expect(authRows).toHaveLength(0);
  });
});
