// Real-wiring integration tests — sighting/found-pet notification inserts.
//
// THE top gap from the 2026-07 critical-failure matrix: the single
// db.insert(notifications) in reportPetSighting (report-pet-sighting.ts
// ~262-276) is deliberately swallowed on failure (ARCH-P) — a typo'd
// notificationType/category, a wrong userId column, or a broken owner lookup
// fails SILENTLY in production and in every mock-based test. These tests run
// the REAL use-cases against the REAL local database and assert the actual
// inserted rows, with the enum-ish text columns asserted as STRING LITERALS
// (notifications.notification_type / .category are unchecked text — a typo'd
// value is exactly the silent failure this file exists to catch).
//
// Mocked: next/headers ONLY (to inject the caller IP; the rate limiter is
// REAL and DB-backed, so each call in this file uses a distinct IP to stay
// under the 1/min budget). No photo is submitted, so no upload path runs.
//
// Seeding/teardown pattern mirrors __tests__/lost-mode-sightings.test.ts.

import { sql } from "drizzle-orm";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Mock next/headers before importing the use-cases. `currentIp` is mutable so
// each anonymous submission can present a fresh caller IP to the REAL
// DB-backed rate limiter (1/min per IP+token).
const { headerState } = vi.hoisted(() => ({ headerState: { ip: "203.0.113.1" } }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key === "x-real-ip" ? headerState.ip : null),
  })),
}));

import { db, notifications, ownerships, pets, profiles } from "@/db";
import { notifyOwnerOfFoundPet } from "@/src/modules/pets/application/public/notify-owner-of-found-pet";
import { reportPetSighting } from "@/src/modules/pets/application/sighting/report-pet-sighting";
import { withMutationOverride } from "./_helpers/db-overrides";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PET_TOKEN = "DIM-WIRE-SIGHT-1";

// Bare-profile pattern (see transferencias-inbox.test.ts) — profiles.id has no
// FK to auth.users, so hardcoded UUIDs insert directly.
const OWNER_1_ID = "00000000-0000-0000-0000-0000000b0001";
const OWNER_2_ID = "00000000-0000-0000-0000-0000000b0002";

let petId: string;
let nextIpOctet = 1;

/** Fresh caller IP per anonymous submission — keeps the REAL rate limiter cold. */
function useFreshIp(): void {
  headerState.ip = `203.0.113.${nextIpOctet++}`;
}

function sightingFormData(description: string): FormData {
  const fd = new FormData();
  fd.set("locationLat", "-34.6037");
  fd.set("locationLng", "-58.3816");
  fd.set("description", description);
  return fd;
}

async function notificationsFor(userId: string) {
  return db.select().from(notifications).where(eq(notifications.userId, userId));
}

async function cleanupFixtures() {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM notifications WHERE user_id IN (
      ${OWNER_1_ID}::uuid, ${OWNER_2_ID}::uuid
    )`);
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM ownerships WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
    await tx.execute(sql`DELETE FROM profiles WHERE id IN (
      ${OWNER_1_ID}::uuid, ${OWNER_2_ID}::uuid
    )`);
    // Rate-limit buckets from a previous aborted run of this file.
    await tx.execute(sql`DELETE FROM rate_limit_buckets
      WHERE bucket_key LIKE ${`sighting:${PET_TOKEN}:%`}
         OR bucket_key LIKE ${`found_notify:${PET_TOKEN}:%`}`);
  });
}

beforeAll(async () => {
  await cleanupFixtures();

  await db.insert(profiles).values([
    { id: OWNER_1_ID, displayName: "WireOwnerOne" },
    { id: OWNER_2_ID, displayName: "WireOwnerTwo" },
  ]);

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "WiringTestDog",
      species: "dog",
      sex: "unknown",
      status: "lost",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId = pet.id;

  await db.insert(ownerships).values({
    petId,
    ownerUserId: OWNER_1_ID,
    role: "owner",
  });
});

afterAll(async () => {
  await cleanupFixtures();
});

// ---------------------------------------------------------------------------
// Phase 1 — sighting report notifies the ACTIVE owner with the literal
// notification contract
// ---------------------------------------------------------------------------

describe("reportPetSighting — real notification wiring (active owner)", () => {
  it("inserts a REAL notifications row addressed to the active owner", async () => {
    useFreshIp();
    const result = await reportPetSighting(
      PET_TOKEN,
      { ok: false, error: null },
      sightingFormData("Lo vi en la plaza."),
    );
    expect(result).toEqual({ ok: true, error: null, warning: null });

    const rows = await notificationsFor(OWNER_1_ID);
    expect(rows).toHaveLength(1);
    const n = rows[0];
    // STRING LITERALS — the columns are unchecked text; a typo'd value is the
    // exact silent failure the swallowed insert (ARCH-P) would hide.
    // Taxonomy (tester fix #1): a sighting is its OWN type, never
    // pet_found_report, and warning severity (high-but-distinct from the
    // urgent possession/found alerts).
    expect(n.notificationType).toBe("pet_sighting");
    expect(n.category).toBe("perdidas");
    expect(n.severity).toBe("warning");
    expect(n.title).toBe("Avistaje de WiringTestDog");
    expect(n.ctaLabel).toBe("Ver mascota");
    expect(n.ctaUrl).toBe("/mis-mascotas/DIM-WIRE-SIGHT-1");
    expect(n.relatedPetId).toBe(petId);
    expect(n.body).toContain('Mensaje: "Lo vi en la plaza."');
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — ownership transfer: the NEW owner gets the notification, the old
// owner gets nothing new
// ---------------------------------------------------------------------------

describe("reportPetSighting — after an ownership transfer", () => {
  it("routes the notification to the NEW active owner only", async () => {
    // Simulate an accepted transfer: end owner 1's tenure, open owner 2's.
    await db
      .update(ownerships)
      .set({ endedAt: new Date() })
      .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)));
    await db.insert(ownerships).values({
      petId,
      ownerUserId: OWNER_2_ID,
      role: "owner",
    });

    const owner1Before = (await notificationsFor(OWNER_1_ID)).length;

    useFreshIp();
    const result = await reportPetSighting(
      PET_TOKEN,
      { ok: false, error: null },
      sightingFormData("Ahora lo vi cerca del lago."),
    );
    expect(result).toEqual({ ok: true, error: null, warning: null });

    // New owner received the sighting notification with the same literal contract.
    const owner2Rows = await notificationsFor(OWNER_2_ID);
    expect(owner2Rows).toHaveLength(1);
    expect(owner2Rows[0].notificationType).toBe("pet_sighting");
    expect(owner2Rows[0].category).toBe("perdidas");
    expect(owner2Rows[0].body).toContain('Mensaje: "Ahora lo vi cerca del lago."');

    // Previous owner received NOTHING new.
    const owner1After = (await notificationsFor(OWNER_1_ID)).length;
    expect(owner1After).toBe(owner1Before);
  });
});

// ---------------------------------------------------------------------------
// notifyOwnerOfFoundPet — one real-insert case (same swallowed-insert hazard)
// ---------------------------------------------------------------------------

describe("notifyOwnerOfFoundPet — real notification wiring", () => {
  it("inserts a REAL notifications row for the active owner with the literal contract", async () => {
    const fd = new FormData();
    fd.set("finderName", "Vecina Marta");
    fd.set("finderContact", "11-4444-5555");
    fd.set("message", "La tengo en mi patio.");

    useFreshIp();
    const result = await notifyOwnerOfFoundPet(PET_TOKEN, { ok: false, error: null }, fd);
    expect(result).toEqual({ ok: true, error: null });

    // Owner 2 is the active owner after phase 2; it now has the phase-2
    // sighting notification plus this found-pet one.
    const rows = await notificationsFor(OWNER_2_ID);
    const found = rows.filter((n) => n.title === "Alguien encontró a WiringTestDog");
    expect(found).toHaveLength(1);
    const n = found[0];
    expect(n.notificationType).toBe("pet_found_report");
    expect(n.category).toBe("perdidas");
    expect(n.severity).toBe("urgent");
    expect(n.ctaLabel).toBe("Ver mascota");
    expect(n.ctaUrl).toBe("/mis-mascotas/DIM-WIRE-SIGHT-1");
    expect(n.relatedPetId).toBe(petId);
    expect(n.body).toBe(
      'Vecina Marta dejó un mensaje: "La tengo en mi patio.". Te podés contactar al 11-4444-5555.',
    );
  });
});
