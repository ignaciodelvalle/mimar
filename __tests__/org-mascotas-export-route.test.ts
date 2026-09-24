// Integration test for the org roster export route (org-first readiness #4):
// GET /org/[orgToken]/mascotas/exportar.
//
// Four properties, all of them things a unit test cannot see:
//   1. AUTHZ — a session with no membership in the URL org is refused.
//   2. SCOPE — two orgs exist with animals; neither export can contain the
//      other's. This is the one that matters: an export that leaks is a data
//      breach with a filename.
//   3. ENCODING — a real UTF-8 BOM on the wire, so Excel es-AR opens the file
//      with accents intact instead of "Ni√±a".
//   4. ROUND TRIP — the downloaded bytes go back through the IMPORT path
//      (decodeIntakeCsv → sniff → parse → mapIntakeCsvRecord) with no errors.
//      The exit ramp is only an exit ramp if what comes out can go back in.
//
// Live-DB pattern mirrors __tests__/adoption-contract-route.test.ts (admin
// client + session mock + withMutationOverride cleanup).

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { parse } from "csv-parse/sync";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import {
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
import {
  INTAKE_CSV_EXPORT_STATUS_HEADER,
  decodeIntakeCsv,
  mapIntakeCsvRecord,
  sniffIntakeCsvDelimiter,
} from "@/lib/domain/intake-csv";
import { createClient } from "@/lib/supabase/server";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const ADMIN_A_EMAIL = "roster-export-admin-a@dim-test.local";
const ADMIN_B_EMAIL = "roster-export-admin-b@dim-test.local";
const OUTSIDER_EMAIL = "roster-export-outsider@dim-test.local";
const PASS = "Roster_2026!";

const ORG_A_TOKEN = "DIM-ROSTER-A";
const ORG_B_TOKEN = "DIM-ROSTER-B";

// Org A's animals. The accented name is the BOM's job description: without the
// BOM Excel es-AR renders it mojibake, and the operator's roster is unreadable.
const PET_A1_TOKEN = "DIM-ROST-A001";
const PET_A1_NAME = "Niña Ñandú";
const PET_A1_CHIP = "900111222333444";
const PET_A2_TOKEN = "DIM-ROST-A002";
const PET_A2_NAME = "Segundo";

// Org B's animal — the one that must NEVER appear in org A's file.
const PET_B1_TOKEN = "DIM-ROST-B001";
const PET_B1_NAME = "AjenoDeOtraOrg";
const PET_B1_CHIP = "900999888777666";

const PET_TOKENS = [PET_A1_TOKEN, PET_A2_TOKEN, PET_B1_TOKEN];
const ORG_TOKENS = [ORG_A_TOKEN, ORG_B_TOKEN];

let adminAUserId: string;
let adminBUserId: string;
let outsiderUserId: string;
let orgAId: string;
let orgBId: string;
const petIdByToken = new Map<string, string>();

function mockSessionAs(userId: string) {
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({ data: { user: { id: userId } as unknown }, error: null }),
    },
  } as never);
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

async function purgePetByToken(token: string) {
  await withMutationOverride(async (tx) => {
    const stale = await tx.select({ id: pets.id }).from(pets).where(eq(pets.publicToken, token));
    for (const { id } of stale) {
      await tx.delete(notifications).where(eq(notifications.relatedPetId, id));
      await tx.delete(petIdentifications).where(eq(petIdentifications.petId, id));
      await tx.delete(ownerships).where(eq(ownerships.petId, id));
      await tx.delete(petEvents).where(eq(petEvents.petId, id));
      await tx.delete(pets).where(eq(pets.id, id));
    }
  });
}

async function purgeOrgByToken(token: string) {
  const stale = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.publicToken, token));
  for (const { id } of stale) {
    await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, id));
    await db.delete(organizations).where(eq(organizations.id, id));
  }
}

async function loadRoute() {
  return import("@/app/org/[orgToken]/mascotas/exportar/route");
}

function exportRequest(orgToken: string): Request {
  return new Request(`http://test.local/org/${orgToken}/mascotas/exportar`);
}

function routeParams(orgToken: string) {
  return { params: Promise.resolve({ orgToken }) };
}

/** Seed one animal under `orgId` with a real intake event, as intake writes it. */
async function seedPet(input: {
  orgId: string;
  token: string;
  name: string;
  chip: string | null;
  occurredAt: Date;
  intakeReason: string;
}) {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: input.token,
      name: input.name,
      species: "dog",
      sex: "female",
      breed: "mestizo",
      color: "negro",
      distinguishingFeatures: "mancha blanca en el pecho",
      estimatedWeightKg: "12.50",
      dateOfBirth: "2024-01-15",
      birthDateIsEstimated: true,
      potentiallyDangerousBreed: false,
    })
    .returning();
  petIdByToken.set(input.token, pet.id);

  await db.insert(ownerships).values({
    petId: pet.id,
    ownerOrganizationId: input.orgId,
    role: "shelter_custody",
    startedAt: input.occurredAt,
  });

  await withMutationOverride(async (tx) => {
    await tx.insert(petEvents).values({
      petId: pet.id,
      eventType: "shelter_intake_recorded",
      occurredAt: input.occurredAt,
      recordedAt: new Date(),
      authorRole: "shelter",
      authorOrganizationId: input.orgId,
      authorVerified: true,
      payload: {
        intake_reason: input.intakeReason,
        intake_condition: "buen estado general",
        rescue_jurisdiction: "La Plata, Buenos Aires",
      },
    });
  });

  if (input.chip) {
    await db.insert(petIdentifications).values({
      petId: pet.id,
      kind: "microchip_iso",
      status: "active",
      code: input.chip,
      isoCountryCode: "032",
    });
  }
}

beforeAll(async () => {
  for (const token of PET_TOKENS) await purgePetByToken(token);
  for (const token of ORG_TOKENS) await purgeOrgByToken(token);
  for (const email of [ADMIN_A_EMAIL, ADMIN_B_EMAIL, OUTSIDER_EMAIL]) {
    await purgeUserByEmail(email);
  }

  const mkUser = async (email: string) => {
    const r = await createFreshTestUser(supabaseAdmin, {
      email,
      password: PASS,
      email_confirm: true,
    });
    if (r.error || !r.data.user) throw new Error(`createUser ${email}: ${r.error?.message}`);
    return r.data.user.id;
  };

  adminAUserId = await mkUser(ADMIN_A_EMAIL);
  adminBUserId = await mkUser(ADMIN_B_EMAIL);
  outsiderUserId = await mkUser(OUTSIDER_EMAIL);
  for (const id of [adminAUserId, adminBUserId, outsiderUserId]) {
    await db
      .update(profiles)
      .set({ role: "owner", accountType: "personal" })
      .where(eq(profiles.id, id));
  }

  const mkOrg = async (token: string, name: string) => {
    const [org] = await db
      .insert(organizations)
      .values({
        publicToken: token,
        legalName: `${name} SRL`,
        displayName: name,
        orgType: "shelter",
        email: `${token.toLowerCase()}@dim-test.local`,
        verified: true,
      })
      .returning();
    return org.id;
  };

  orgAId = await mkOrg(ORG_A_TOKEN, "Roster Refugio A");
  orgBId = await mkOrg(ORG_B_TOKEN, "Roster Refugio B");

  await db.insert(organizationMemberships).values([
    { organizationId: orgAId, userId: adminAUserId, role: "admin", canWritePetEvents: true },
    { organizationId: orgBId, userId: adminBUserId, role: "admin", canWritePetEvents: true },
  ]);

  await seedPet({
    orgId: orgAId,
    token: PET_A1_TOKEN,
    name: PET_A1_NAME,
    chip: PET_A1_CHIP,
    occurredAt: new Date("2026-07-01T12:00:00Z"),
    intakeReason: "rescue",
  });
  await seedPet({
    orgId: orgAId,
    token: PET_A2_TOKEN,
    name: PET_A2_NAME,
    chip: null,
    occurredAt: new Date("2026-07-05T12:00:00Z"),
    intakeReason: "surrender",
  });
  await seedPet({
    orgId: orgBId,
    token: PET_B1_TOKEN,
    name: PET_B1_NAME,
    chip: PET_B1_CHIP,
    occurredAt: new Date("2026-07-03T12:00:00Z"),
    intakeReason: "stray_found",
  });
});

afterAll(async () => {
  for (const token of PET_TOKENS) await purgePetByToken(token);
  for (const token of ORG_TOKENS) await purgeOrgByToken(token);
  for (const email of [ADMIN_A_EMAIL, ADMIN_B_EMAIL, OUTSIDER_EMAIL]) {
    await purgeUserByEmail(email);
  }
});

/** The IMPORT path's own reader, byte-for-byte: decode → sniff → parse. */
async function readAsImportWould(res: Response): Promise<Record<string, string>[]> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const { text } = decodeIntakeCsv(bytes);
  return parse(text, {
    columns: true,
    delimiter: sniffIntakeCsvDelimiter(text),
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
}

describe("GET /org/[orgToken]/mascotas/exportar", () => {
  it("refuses a session with no membership in the URL org (403, no file)", async () => {
    mockSessionAs(outsiderUserId);
    const { GET } = await loadRoute();
    const res = await GET(exportRequest(ORG_A_TOKEN), routeParams(ORG_A_TOKEN));
    expect(res.status).toBe(403);
    expect(res.headers.get("Content-Disposition")).toBeNull();
  });

  it("refuses a member of ANOTHER org asking for this org's roster", async () => {
    // The confused-deputy case: org B's admin holds pet.read_held — but for
    // org B. Pinning the capability to the URL token is what makes this a 403
    // instead of a cross-org download.
    mockSessionAs(adminBUserId);
    const { GET } = await loadRoute();
    const res = await GET(exportRequest(ORG_A_TOKEN), routeParams(ORG_A_TOKEN));
    expect(res.status).toBe(403);
  });

  it("downloads as an attachment named mascotas-{orgToken}-{yyyymmdd}.csv", async () => {
    mockSessionAs(adminAUserId);
    const { GET } = await loadRoute();
    const res = await GET(exportRequest(ORG_A_TOKEN), routeParams(ORG_A_TOKEN));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toMatch(
      new RegExp(`^attachment; filename="mascotas-${ORG_A_TOKEN}-\\d{8}\\.csv"$`),
    );
    // A roster is a live read of custody state — never cached.
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("starts with a UTF-8 BOM so Excel es-AR keeps the accents", async () => {
    mockSessionAs(adminAUserId);
    const { GET } = await loadRoute();
    const res = await GET(exportRequest(ORG_A_TOKEN), routeParams(ORG_A_TOKEN));

    // BOM check on the RAW bytes — Response.text() strips a leading BOM during
    // UTF-8 decode, so the string view cannot see it.
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);

    // And the accented name survives the trip, which is what the BOM buys.
    const rows = await readAsImportWould(res);
    expect(rows.map((r) => r["nombre*"])).toContain(PET_A1_NAME);
  });

  it("contains ONLY this org's animals — cross-org contamination is impossible", async () => {
    const { GET } = await loadRoute();

    mockSessionAs(adminAUserId);
    const resA = await GET(exportRequest(ORG_A_TOKEN), routeParams(ORG_A_TOKEN));
    const rawA = await resA.clone().text();
    const namesA = (await readAsImportWould(resA)).map((r) => r["nombre*"]);

    mockSessionAs(adminBUserId);
    const resB = await GET(exportRequest(ORG_B_TOKEN), routeParams(ORG_B_TOKEN));
    const rawB = await resB.clone().text();
    const namesB = (await readAsImportWould(resB)).map((r) => r["nombre*"]);

    // Positive first, so the negatives below cannot pass on an empty file.
    expect(namesA).toEqual(expect.arrayContaining([PET_A1_NAME, PET_A2_NAME]));
    expect(namesB).toEqual(expect.arrayContaining([PET_B1_NAME]));

    expect(namesA).not.toContain(PET_B1_NAME);
    expect(namesB).not.toContain(PET_A1_NAME);
    expect(namesB).not.toContain(PET_A2_NAME);
    // The chip is the identifier that would hurt most in the wrong file.
    expect(rawB).not.toContain(PET_A1_CHIP);
    expect(rawA).not.toContain(PET_B1_CHIP);
  });

  it("round-trips: every exported row maps back through the import with no errors", async () => {
    mockSessionAs(adminAUserId);
    const { GET } = await loadRoute();
    const res = await GET(exportRequest(ORG_A_TOKEN), routeParams(ORG_A_TOKEN));
    const rows = await readAsImportWould(res);
    expect(rows.length).toBe(2);

    for (const record of rows) {
      const { fields, errors } = mapIntakeCsvRecord(record);
      expect(errors, `row ${record["nombre*"]}`).toEqual([]);
      expect(fields.species).toBe("dog");
      expect(fields.sex).toBe("female");
      expect(fields.custodyRole).toBe("shelter_custody");
      // dd/mm/aaaa → ISO, which is what proves the date column is written in
      // the form the import (and Excel es-AR) expects.
      expect(fields.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Decimal comma out, dot in.
      expect(fields.estimatedWeightKg).toBe("12.5");
      expect(fields.rescueJurisdiction).toBe("La Plata, Buenos Aires");
    }

    const negrita = rows.find((r) => r["nombre*"] === PET_A1_NAME);
    const { fields } = mapIntakeCsvRecord(negrita as Record<string, string>);
    // Identifiers the org already sees on the ficha travel with the roster.
    expect(fields.microchipId).toBe(PET_A1_CHIP);
    expect(fields.intakeReason).toBe("rescue");
    expect(fields.occurredAt).toBe("2026-07-01");
    // The export-only column is present in the file and ignored on the way back.
    expect(negrita?.[INTAKE_CSV_EXPORT_STATUS_HEADER]).toBe("Activa");
    expect(fields).not.toHaveProperty(INTAKE_CSV_EXPORT_STATUS_HEADER);
  });

  it("carries no human PII — the roster is about animals", async () => {
    mockSessionAs(adminAUserId);
    const { GET } = await loadRoute();
    const res = await GET(exportRequest(ORG_A_TOKEN), routeParams(ORG_A_TOKEN));
    const header = (await res.text()).replace(/^﻿/, "").split("\r\n")[0].toLowerCase();

    // The catalog is fixed, so this is a fence on the catalog: no column may be
    // added that carries a person.
    for (const forbidden of ["dni", "email", "correo", "telefono", "teléfono", "dueno", "dueño"]) {
      expect(header, `header must not offer a ${forbidden} column`).not.toContain(forbidden);
    }
  });
});
