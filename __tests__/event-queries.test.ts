// Integration test for excludeSelfScansClause.
//
// Confirms the SQL clause does what the helper promises:
// (1) drops credential_scanned rows whose payload.is_self_scan === true,
// (2) keeps credential_scanned rows whose payload.is_self_scan !== true,
// (3) keeps all other event types regardless of their payload contents.

import { createClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, petEvents, pets } from "@/db";
import { excludeSelfScansClause } from "@/lib/events/events";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const EMAIL = "self-scan-filter-test@dim-test.local";
const PASS = "SelfScanFilter_2026!";

let userId: string;
let petId: string;
let selfScanEventId: string;
let externalScanEventId: string;
let noteEventId: string;

beforeAll(async () => {
  const { data: list } = await admin.auth.admin.listUsers();
  const found = list?.users.find((u) => u.email === EMAIL);
  if (found) {
    const owned = await db.select().from(ownerships).where(eq(ownerships.ownerUserId, found.id));
    await withMutationOverride(async (tx) => {
      for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
    });
    await admin.auth.admin.deleteUser(found.id);
  }
  const { data, error } = await createFreshTestUser(admin, {
    email: EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `SELFSCAN-${userId.slice(0, 6).toUpperCase()}`,
      name: "Sombra",
      species: "dog",
      sex: "unknown",
      status: "active",
    })
    .returning();
  petId = pet.id;
  await db.insert(ownerships).values({ petId, ownerUserId: userId, role: "owner" });

  const now = new Date();
  const [selfScan] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "credential_scanned",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: userId,
      authorRole: "owner",
      payload: { payload_version: 1, is_self_scan: true, viewer_authenticated: true },
    })
    .returning();
  selfScanEventId = selfScan.id;

  const [externalScan] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "credential_scanned",
      occurredAt: new Date(now.getTime() + 1000),
      recordedAt: now,
      recordedByUserId: null,
      authorRole: "system",
      payload: { payload_version: 1, is_self_scan: false, viewer_authenticated: false },
    })
    .returning();
  externalScanEventId = externalScan.id;

  const [note] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "note_added",
      occurredAt: new Date(now.getTime() + 2000),
      recordedAt: now,
      recordedByUserId: userId,
      authorRole: "owner",
      payload: { payload_version: 1, category: null, text: "Camina bien." },
    })
    .returning();
  noteEventId = note.id;
});

afterAll(async () => {
  const owned = await db.select().from(ownerships).where(eq(ownerships.ownerUserId, userId));
  await withMutationOverride(async (tx) => {
    for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
  });
  await admin.auth.admin.deleteUser(userId);
});

describe("excludeSelfScansClause", () => {
  it("excludes credential_scanned rows where payload.is_self_scan === true", async () => {
    const rows = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), excludeSelfScansClause()));
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(selfScanEventId);
  });

  it("keeps credential_scanned rows where payload.is_self_scan === false", async () => {
    const rows = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), excludeSelfScansClause()));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(externalScanEventId);
  });

  it("keeps all non-credential_scanned events regardless of payload", async () => {
    const rows = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), excludeSelfScansClause()));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(noteEventId);
  });

  it("returns exactly the expected event ids for this pet (2 of 3)", async () => {
    const rows = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), excludeSelfScansClause()));
    expect(rows).toHaveLength(2);
  });
});
