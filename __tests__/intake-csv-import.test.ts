// Integration test for the bulk-intake CSV actions (org-pilot-pack Req 1)
// against the real local Postgres:
//
//   - capability gate on validate + import
//   - per-row preview: valid/invalid split with named errors, duplicate flag
//   - import writes through the EXISTING per-animal use-case (real
//     pet_registered + shelter_intake_recorded events, real custody)
//   - chunk idempotency (spec 1.7, HARD): resubmitting the same fileHash/rows
//     creates NO duplicate events and reports the original pets
//   - lost-chip backstop: a lost-chip match row is skipped, not imported
//   - tattoo-match rows are skipped ("verificación por foto")
//   - zero-valid-rows: nothing importable, import of empty set errors
//
// Live-DB pattern mirrors __tests__/adoption-cascade.test.ts.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { and, count, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import {
  importIntakeRowsAction,
  validateIntakeCsvAction,
} from "@/app/org/[orgToken]/intake/importar/actions";
import {
  cases,
  db,
  notifications,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  petIdentifications,
  pets,
  profiles,
} from "@/db";
import { createClient } from "@/lib/supabase/server";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const COORD_EMAIL = "csvimp-coord@dim-test.local";
const OUTSIDER_EMAIL = "csvimp-outsider@dim-test.local";
const PASS = "CsvImport_2026!";

const ORG_TOKEN = "DIM-CSVIMP-001";
const LOST_PET_TOKEN = "DIM-CSVI-LOST1";
const TATTOO_PET_TOKEN = "DIM-CSVI-TATT1";
const LOST_CHIP = "982000123456789";
const TATTOO_CODE = "K9TEST01";

let coordUserId: string;
let outsiderUserId: string;
let orgId: string;
let lostPetId: string;
let tattooPetId: string;

/** publicTokens of pets created THROUGH the import — cleaned up in afterAll. */
const createdPetTokens: string[] = [];

function mockSessionAs(userId: string) {
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: { user: { id: userId } as unknown },
        error: null,
      }),
    },
  } as never);
}

const CSV_HEADER = "nombre*;especie*;sexo;microchip;tatuaje;motivo_ingreso*;fecha_ingreso*";

function csvUpload(dataRows: string[]): FormData {
  const text = `﻿${[CSV_HEADER, ...dataRows].join("\r\n")}\r\n`;
  const file = new File([new TextEncoder().encode(text)], "import.csv", { type: "text/csv" });
  const fd = new FormData();
  fd.set("file", file);
  return fd;
}

async function purgeUserByEmail(email: string) {
  const { data } = await supabaseAdmin.auth.admin.listUsers();
  const found = data?.users.find((u) => u.email === email);
  if (!found) return;
  await withMutationOverride(async (tx) => {
    await tx.delete(notifications).where(eq(notifications.userId, found.id));
    await tx.delete(organizationMemberships).where(eq(organizationMemberships.userId, found.id));
    await tx.delete(ownerships).where(eq(ownerships.ownerUserId, found.id));
    await tx.delete(profiles).where(eq(profiles.id, found.id));
  });
  await supabaseAdmin.auth.admin.deleteUser(found.id);
}

async function deletePetsByTokens(tokens: string[]) {
  if (tokens.length === 0) return;
  const rows = await db.select({ id: pets.id }).from(pets).where(inArray(pets.publicToken, tokens));
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return;
  await withMutationOverride(async (tx) => {
    for (const id of ids) {
      await tx.delete(notifications).where(eq(notifications.relatedPetId, id));
      await tx.delete(petEvents).where(eq(petEvents.petId, id));
      await tx.delete(cases).where(eq(cases.primaryPetId, id));
      await tx.delete(petIdentifications).where(eq(petIdentifications.petId, id));
      await tx.delete(ownerships).where(eq(ownerships.petId, id));
      await tx.delete(pets).where(eq(pets.id, id));
    }
  });
}

beforeAll(async () => {
  await deletePetsByTokens([LOST_PET_TOKEN, TATTOO_PET_TOKEN]);
  const staleOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.publicToken, ORG_TOKEN));
  for (const { id } of staleOrgs) {
    await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, id));
    await db.delete(organizations).where(eq(organizations.id, id));
  }
  for (const email of [COORD_EMAIL, OUTSIDER_EMAIL]) {
    await purgeUserByEmail(email);
  }

  const mkUser = async (email: string, name: string) => {
    const r = await createFreshTestUser(supabaseAdmin, {
      email,
      password: PASS,
      email_confirm: true,
    });
    if (r.error || !r.data.user) throw new Error(`createUser ${email}: ${r.error?.message}`);
    await db
      .update(profiles)
      .set({ displayName: name, role: "owner", accountType: "personal" })
      .where(eq(profiles.id, r.data.user.id));
    return r.data.user.id;
  };

  coordUserId = await mkUser(COORD_EMAIL, "CSV Coord");
  outsiderUserId = await mkUser(OUTSIDER_EMAIL, "CSV Outsider");

  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN,
      legalName: "CSV Import Test Refugio SRL",
      displayName: "CSV Import Refugio",
      orgType: "shelter",
      email: "csvimp@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;

  await db.insert(organizationMemberships).values({
    organizationId: orgId,
    userId: coordUserId,
    role: "admin",
    canWritePetEvents: true,
  });

  // Seed a LOST pet with an active chip (lost-chip backstop) and an
  // active pet with a tattoo (photo-verification skip).
  const [lostPet] = await db
    .insert(pets)
    .values({
      publicToken: LOST_PET_TOKEN,
      name: "Perdido Chip",
      species: "dog",
      sex: "male",
      status: "lost",
      potentiallyDangerousBreed: false,
    })
    .returning();
  lostPetId = lostPet.id;
  await db.insert(petIdentifications).values({
    petId: lostPetId,
    kind: "microchip_iso",
    code: LOST_CHIP,
    recordedAt: "2026-01-15",
    recordedByUserId: coordUserId,
    isoCountryCode: LOST_CHIP.slice(0, 3),
    isoManufacturerCode: LOST_CHIP.slice(3, 7),
    isoNationalId: LOST_CHIP.slice(7, 15),
    isoCompliant: true,
  });

  const [tattooPet] = await db
    .insert(pets)
    .values({
      publicToken: TATTOO_PET_TOKEN,
      name: "Tatuada",
      species: "dog",
      sex: "female",
      status: "active",
      potentiallyDangerousBreed: false,
    })
    .returning();
  tattooPetId = tattooPet.id;
  await db.insert(petIdentifications).values({
    petId: tattooPetId,
    kind: "tattoo",
    code: TATTOO_CODE,
    recordedAt: "2026-01-15",
    recordedByUserId: coordUserId,
  });
});

afterAll(async () => {
  await deletePetsByTokens([...createdPetTokens, LOST_PET_TOKEN, TATTOO_PET_TOKEN]);
  await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  for (const email of [COORD_EMAIL, OUTSIDER_EMAIL]) {
    await purgeUserByEmail(email);
  }
});

describe("bulk intake CSV import (validate + import actions)", () => {
  let fileHash = "";
  let validRows: { index: number; fields: Record<string, string> }[] = [];
  let firstRunTokens: string[] = [];

  it("validate: capability gate rejects a non-member session", async () => {
    mockSessionAs(outsiderUserId);
    const result = await validateIntakeCsvAction(
      ORG_TOKEN,
      csvUpload(["Uno;perro;macho;;;rescate;01/07/2026"]),
    );
    expect("error" in result && typeof result.error === "string").toBe(true);
  });

  it("validate: splits valid rows from named per-column errors and flags duplicates", async () => {
    mockSessionAs(coordUserId);
    const result = await validateIntakeCsvAction(
      ORG_TOKEN,
      csvUpload([
        "Bulk Uno;perro;macho;;;rescate;01/07/2026",
        "Bulk Dos;gato;hembra;;;entrega;02/07/2026",
        "Bulk Mala;conejo;macho;;;rescate;01/07/2026",
        "Bulk Uno;perro;macho;;;rescate;01/07/2026",
      ]),
    );
    if ("error" in result) throw new Error(`validate failed: ${result.error}`);

    expect(result.rows).toHaveLength(4);
    expect(result.fileHash).toMatch(/^[0-9a-f]{64}$/);

    const [uno, dos, mala, dupe] = result.rows;
    expect(uno.valid).toBe(true);
    expect(dos.valid).toBe(true);
    expect(dos.fields.species).toBe("cat");
    expect(dos.fields.intakeReason).toBe("surrender");
    // Named error on the offending column (spec 1.3).
    expect(mala.valid).toBe(false);
    expect(mala.errors.some((e) => e.startsWith("especie:"))).toBe(true);
    // Exact full-row duplicate: warned, NOT blocked (spec 1.10).
    expect(dupe.valid).toBe(true);
    expect(dupe.duplicate).toBe(true);
    expect(uno.duplicate).toBe(false);

    fileHash = result.fileHash;
    validRows = result.rows
      .filter((r) => r.valid && !r.duplicate)
      .map((r) => ({ index: r.index, fields: r.fields }));
  });

  it("import: capability gate rejects a non-member session", async () => {
    mockSessionAs(outsiderUserId);
    const result = await importIntakeRowsAction(ORG_TOKEN, { fileHash, rows: validRows });
    expect("error" in result && typeof result.error === "string").toBe(true);
  });

  it("import: writes real intake events through the per-animal use-case", async () => {
    mockSessionAs(coordUserId);
    const result = await importIntakeRowsAction(ORG_TOKEN, { fileHash, rows: validRows });
    if ("error" in result) throw new Error(`import failed: ${result.error}`);

    expect(result.results).toHaveLength(2);
    for (const row of result.results) {
      expect(row.outcome).toBe("imported");
      expect(row.petToken).toBeTruthy();
    }
    firstRunTokens = result.results.map((r) => r.petToken as string).sort();
    createdPetTokens.push(...firstRunTokens);

    // Real spine writes: pet + shelter_custody by THIS org + both events.
    for (const token of firstRunTokens) {
      const [pet] = await db.select().from(pets).where(eq(pets.publicToken, token));
      expect(pet).toBeDefined();

      const [custody] = await db
        .select()
        .from(ownerships)
        .where(and(eq(ownerships.petId, pet.id), eq(ownerships.role, "shelter_custody")));
      expect(custody?.ownerOrganizationId).toBe(orgId);

      const events = await db
        .select({ type: petEvents.eventType })
        .from(petEvents)
        .where(eq(petEvents.petId, pet.id));
      const types = events.map((e) => e.type);
      expect(types).toContain("pet_registered");
      expect(types).toContain("shelter_intake_recorded");
    }
  });

  it("idempotency (spec 1.7 HARD): resubmitting the same chunk creates NO duplicates", async () => {
    mockSessionAs(coordUserId);

    const [before] = await db
      .select({ n: count() })
      .from(pets)
      .where(inArray(pets.publicToken, firstRunTokens));

    const rerun = await importIntakeRowsAction(ORG_TOKEN, { fileHash, rows: validRows });
    if ("error" in rerun) throw new Error(`rerun failed: ${rerun.error}`);

    // Already-committed rows report as no-ops carrying the ORIGINAL pets.
    const rerunTokens = rerun.results.map((r) => r.petToken as string).sort();
    expect(rerunTokens).toEqual(firstRunTokens);

    const [after] = await db
      .select({ n: count() })
      .from(pets)
      .where(inArray(pets.publicToken, firstRunTokens));
    expect(after.n).toBe(before.n);

    // Exactly ONE pet_registered event per pet — no duplicate spine writes.
    for (const token of firstRunTokens) {
      const [pet] = await db.select({ id: pets.id }).from(pets).where(eq(pets.publicToken, token));
      const [registered] = await db
        .select({ n: count() })
        .from(petEvents)
        .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "pet_registered")));
      expect(registered.n).toBe(1);
    }
  });

  it("lost-chip backstop: a lost-chip row is skipped, never imported", async () => {
    mockSessionAs(coordUserId);
    const result = await importIntakeRowsAction(ORG_TOKEN, {
      fileHash: "b".repeat(64),
      rows: [
        {
          index: 0,
          fields: {
            name: "Chip Perdido Row",
            species: "dog",
            intakeReason: "rescue",
            occurredAt: "2026-07-01",
            custodyRole: "shelter_custody",
            microchipId: LOST_CHIP,
          },
        },
      ],
    });
    if ("error" in result) throw new Error(`import failed: ${result.error}`);

    expect(result.results[0].outcome).toBe("skipped");
    expect(result.results[0].reason).toMatch(/individual/i);

    // Nothing was created for that row.
    const [row] = await db
      .select({ n: count() })
      .from(pets)
      .where(eq(pets.name, "Chip Perdido Row"));
    expect(row.n).toBe(0);
  });

  it("tattoo match: validate pre-flags it AND import skips it (photo verification rule)", async () => {
    mockSessionAs(coordUserId);

    // Pre-check at validate time.
    const preview = await validateIntakeCsvAction(
      ORG_TOKEN,
      csvUpload([`Tatuaje Row;perro;macho;;${TATTOO_CODE};rescate;01/07/2026`]),
    );
    if ("error" in preview) throw new Error(`validate failed: ${preview.error}`);
    expect(preview.rows[0].valid).toBe(false);
    expect(preview.rows[0].errors.some((e) => e.includes("foto"))).toBe(true);

    // Write-time backstop if the pre-check is bypassed.
    const result = await importIntakeRowsAction(ORG_TOKEN, {
      fileHash: "c".repeat(64),
      rows: [
        {
          index: 0,
          fields: {
            name: "Tatuaje Row",
            species: "dog",
            intakeReason: "rescue",
            occurredAt: "2026-07-01",
            custodyRole: "shelter_custody",
            tattooCode: TATTOO_CODE,
          },
        },
      ],
    });
    if ("error" in result) throw new Error(`import failed: ${result.error}`);
    expect(result.results[0].outcome).toBe("skipped");
    expect(result.results[0].reason).toMatch(/foto/i);

    const [row] = await db.select({ n: count() }).from(pets).where(eq(pets.name, "Tatuaje Row"));
    expect(row.n).toBe(0);
  });

  it("zero valid rows: preview shows all-invalid; importing an empty set errors", async () => {
    mockSessionAs(coordUserId);
    const preview = await validateIntakeCsvAction(
      ORG_TOKEN,
      csvUpload([";perro;macho;;;rescate;01/07/2026", "Sin Motivo;gato;hembra;;;;01/07/2026"]),
    );
    if ("error" in preview) throw new Error(`validate failed: ${preview.error}`);
    expect(preview.rows.every((r) => !r.valid)).toBe(true);

    const importResult = await importIntakeRowsAction(ORG_TOKEN, {
      fileHash: preview.fileHash,
      rows: [],
    });
    expect("error" in importResult).toBe(true);
  });
});
