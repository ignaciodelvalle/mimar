// Integration tests for createTattooForUser (app/actions/tattoo.ts).
//
// Fixture pattern mirrors microchip-replaced.test.ts: admin-SDK user creation,
// pets + ownerships inserted directly. Photo upload is bypassed — the inner
// writer takes an already-uploaded attachment metadata object, so tests pass
// a synthetic { path, mimeType, size } without touching Supabase storage.

import { createClient } from "@supabase/supabase-js";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { attachments, db, ownerships, petEvents, petIdentifications, pets } from "@/db";
import { normalizeTattooCode } from "@/lib/infra/tattoo-lookup";
import { createTattooForUser } from "@/src/modules/pets/application/tattoo/create-tattoo";
import { withMutationOverride } from "../_helpers/db-overrides";
import { createFreshTestUser } from "../_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const OWNER_EMAIL = "tattoo-owner@dim-test.local";
const PASS = "TattooTest_2026!";

let ownerUserId: string;
let petId: string;

const OWNER_AUTHORSHIP = {
  authorRole: "owner" as const,
  authorOrganizationId: null,
  authorVerified: false,
};

const FAKE_UPLOAD = {
  path: "tattoo-test-fixture.jpg",
  mimeType: "image/jpeg",
  size: 12345,
};

async function purgeUser(email: string) {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === email);
  if (!found) return;
  const owned = await db
    .select({ petId: ownerships.petId })
    .from(ownerships)
    .where(eq(ownerships.ownerUserId, found.id));
  await withMutationOverride(async (tx) => {
    for (const { petId: ownedPetId } of owned) {
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${ownedPetId}::uuid`);
      await tx.execute(sql`DELETE FROM attachments WHERE pet_id = ${ownedPetId}::uuid`);
      await tx.delete(ownerships).where(eq(ownerships.petId, ownedPetId));
      await tx.delete(pets).where(eq(pets.id, ownedPetId));
    }
  });
  await admin.auth.admin.deleteUser(found.id);
}

beforeAll(async () => {
  await purgeUser(OWNER_EMAIL);

  const { data: ownerData, error: ownerErr } = await createFreshTestUser(admin, {
    email: OWNER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (ownerErr || !ownerData.user) throw new Error(`createUser owner: ${ownerErr?.message}`);
  ownerUserId = ownerData.user.id;

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `TAT-${Date.now()}`,
      name: "Tattoo Test Pet",
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    })
    .returning();
  petId = pet.id;

  await db.insert(ownerships).values({
    petId,
    ownerUserId,
    role: "owner",
  });
});

afterAll(async () => {
  if (petId) {
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}::uuid`);
      await tx.execute(sql`DELETE FROM attachments WHERE pet_id = ${petId}::uuid`);
      await tx.delete(ownerships).where(eq(ownerships.petId, petId));
      await tx.delete(pets).where(eq(pets.id, petId));
    });
  }
  if (ownerUserId) await admin.auth.admin.deleteUser(ownerUserId);
});

async function resetPetTattoo() {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}::uuid`);
    await tx.execute(sql`DELETE FROM attachments WHERE pet_id = ${petId}::uuid`);
    await tx.execute(sql`DELETE FROM pet_identifications WHERE pet_id = ${petId}::uuid`);
  });
}

describe("normalizeTattooCode", () => {
  it("uppercases and strips whitespace", () => {
    expect(normalizeTattooCode("  k9-2014  ")).toBe("K9-2014");
    expect(normalizeTattooCode("abc 123")).toBe("ABC123");
    expect(normalizeTattooCode("X")).toBe("X");
    expect(normalizeTattooCode("")).toBe("");
    expect(normalizeTattooCode("   ")).toBe("");
  });
});

describe("createTattooForUser", () => {
  it("creates event + attachment + canonical identification row", async () => {
    await resetPetTattoo();

    const result = await createTattooForUser(petId, ownerUserId, OWNER_AUTHORSHIP, {
      code: "K9-2014-A",
      location: "inner_ear_left",
      description: "Criadero FCA",
      recordedAt: new Date("2014-03-15"),
      recordedBy: "Vet Dra. López",
      uploadedAttachment: FAKE_UPLOAD,
    });

    expect("ok" in result && result.ok).toBe(true);
    if (!("ok" in result)) throw new Error("expected ok");

    const events = await db.select().from(petEvents).where(eq(petEvents.id, result.eventId));
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("tattoo_recorded");
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.tattoo_code).toBe("K9-2014-A");
    expect(payload.location_on_body).toBe("inner_ear_left");
    expect(payload.description).toBe("Criadero FCA");
    expect(payload.tattoo_date_known).toBe(true);

    const attachmentRows = await db
      .select()
      .from(attachments)
      .where(eq(attachments.eventId, result.eventId));
    expect(attachmentRows).toHaveLength(1);
    expect(attachmentRows[0].storagePath).toBe(FAKE_UPLOAD.path);

    // Canonical row in pet_identifications (legacy pets.* tattoo columns removed — ARCH-R).
    const canonicalRows = await db
      .select()
      .from(petIdentifications)
      .where(eq(petIdentifications.petId, petId));
    expect(canonicalRows).toHaveLength(1);
    expect(canonicalRows[0].kind).toBe("tattoo");
    expect(canonicalRows[0].code).toBe("K9-2014-A");
    expect(canonicalRows[0].tattooLocation).toBe("inner_ear_left");
    expect(canonicalRows[0].tattooDescription).toBe("Criadero FCA");
    expect(canonicalRows[0].photoId).toBe(attachmentRows[0].id);
  });

  it("normalizes the code before persisting (trim + uppercase + collapse whitespace)", async () => {
    await resetPetTattoo();

    const result = await createTattooForUser(petId, ownerUserId, OWNER_AUTHORSHIP, {
      code: "  k9 2014  ",
      location: null,
      description: null,
      recordedAt: null,
      recordedBy: null,
      uploadedAttachment: FAKE_UPLOAD,
    });

    expect("ok" in result && result.ok).toBe(true);
    if (!("ok" in result)) throw new Error("expected ok");

    // Canonical row carries the normalized code (legacy pets.tattooCode removed — ARCH-R).
    const canonicalRows = await db
      .select()
      .from(petIdentifications)
      .where(eq(petIdentifications.petId, petId));
    expect(canonicalRows).toHaveLength(1);
    expect(canonicalRows[0].code).toBe("K92014");

    const events = await db.select().from(petEvents).where(eq(petEvents.id, result.eventId));
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.tattoo_code).toBe("K92014");
    expect(payload.tattoo_date_known).toBe(false);
  });

  it("rejects empty / whitespace-only codes", async () => {
    const emptyResult = await createTattooForUser(petId, ownerUserId, OWNER_AUTHORSHIP, {
      code: "",
      location: null,
      description: null,
      recordedAt: null,
      recordedBy: null,
      uploadedAttachment: FAKE_UPLOAD,
    });
    expect("error" in emptyResult).toBe(true);

    const wsResult = await createTattooForUser(petId, ownerUserId, OWNER_AUTHORSHIP, {
      code: "   ",
      location: null,
      description: null,
      recordedAt: null,
      recordedBy: null,
      uploadedAttachment: FAKE_UPLOAD,
    });
    expect("error" in wsResult).toBe(true);
  });

  it("rejects invalid location strings", async () => {
    const result = await createTattooForUser(petId, ownerUserId, OWNER_AUTHORSHIP, {
      code: "ABC-123",
      // Cast to bypass the TS enum so we can exercise the runtime guard.
      location: "left_arm" as unknown as "other",
      description: null,
      recordedAt: null,
      recordedBy: null,
      uploadedAttachment: FAKE_UPLOAD,
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/Ubicación/);
    }
  });

  it("re-registration keeps both events in the append-only log and both canonical rows are written", async () => {
    await resetPetTattoo();

    const first = await createTattooForUser(petId, ownerUserId, OWNER_AUTHORSHIP, {
      code: "FIRST-CODE",
      location: "inner_ear_left",
      description: null,
      recordedAt: null,
      recordedBy: null,
      uploadedAttachment: FAKE_UPLOAD,
    });
    expect("ok" in first && first.ok).toBe(true);

    const second = await createTattooForUser(petId, ownerUserId, OWNER_AUTHORSHIP, {
      code: "SECOND-CODE",
      location: "belly",
      description: "re-recorded with better photo",
      recordedAt: null,
      recordedBy: null,
      uploadedAttachment: { ...FAKE_UPLOAD, path: "second-photo.jpg" },
    });
    expect("ok" in second && second.ok).toBe(true);

    const allEvents = await db.select().from(petEvents).where(eq(petEvents.petId, petId));
    expect(allEvents).toHaveLength(2);
    expect(allEvents.every((e) => e.eventType === "tattoo_recorded")).toBe(true);

    // Both canonical rows exist (tattoo identifications are not retired on re-write,
    // only a new one is appended — legacy "overwrite" behavior removed with ARCH-R).
    const canonicalRows = await db
      .select()
      .from(petIdentifications)
      .where(eq(petIdentifications.petId, petId));
    expect(canonicalRows).toHaveLength(2);
    const codes = canonicalRows.map((r) => r.code).sort();
    expect(codes).toEqual(["FIRST-CODE", "SECOND-CODE"]);
  });
});

// ---------------------------------------------------------------------------
// Re-registro: una sola fila activa (hallazgo #3 de la 2a pasada, 2026-08-12)
// ---------------------------------------------------------------------------
//
// El modelo es UN tatuaje activo por mascota, pero no hay flujo de "editar
// tatuaje": corregir un código mal cargado obliga a re-registrar. Sin supersede
// quedaban DOS filas con status='active', y como el read no ordenaba, cuál
// ganaba dependía del orden físico de Postgres — la corrección "no tomaba" de
// forma no-determinística. replace-microchip ya hacía el supersede; el tatuaje
// no lo tenía.
//
// QUÉ TENDRÍA QUE ROMPERSE PARA QUE FALLE: que se saque el supersede.
describe("createTattooForUser — re-registro supersede la fila anterior", () => {
  it("deja exactamente UNA fila activa y es la corregida", async () => {
    const first = await createTattooForUser(petId, ownerUserId, OWNER_AUTHORSHIP, {
      code: "K9-MAL-CARGADO",
      location: "inner_ear_left",
      description: "Código mal tipeado",
      recordedAt: new Date("2015-05-10"),
      recordedBy: "Vet Dra. López",
      uploadedAttachment: FAKE_UPLOAD,
    });
    expect("ok" in first && first.ok).toBe(true);

    // La corrección, con fecha ATRASADA respecto de la primera carga — que es
    // justo el caso que hacía divergir el read del latest-wins.
    const corrected = await createTattooForUser(petId, ownerUserId, OWNER_AUTHORSHIP, {
      code: "K9-CORRECTO",
      location: "inner_thigh",
      description: "Corregido",
      recordedAt: new Date("2015-05-09"),
      recordedBy: "Vet Dra. López",
      uploadedAttachment: FAKE_UPLOAD,
    });
    expect("ok" in corrected && corrected.ok).toBe(true);

    const active = await db
      .select({ code: petIdentifications.code, status: petIdentifications.status })
      .from(petIdentifications)
      .where(
        and(
          eq(petIdentifications.petId, petId),
          eq(petIdentifications.kind, "tattoo"),
          eq(petIdentifications.status, "active"),
        ),
      );

    expect(active).toHaveLength(1);
    expect(active[0].code).toBe("K9-CORRECTO");
  });

  it("la fila vieja queda como 'replaced', no borrada", async () => {
    // El registro histórico no se destruye: se supersede. Misma disciplina que
    // el spine append-only.
    const replaced = await db
      .select({ code: petIdentifications.code })
      .from(petIdentifications)
      .where(
        and(
          eq(petIdentifications.petId, petId),
          eq(petIdentifications.kind, "tattoo"),
          eq(petIdentifications.status, "replaced"),
        ),
      );

    expect(replaced.some((r) => r.code === "K9-MAL-CARGADO")).toBe(true);
  });
});
