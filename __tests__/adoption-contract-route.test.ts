// Integration test for the printable adoption contract route
// (org-pilot-pack Req 3, design D10): POST-only print-ready HTML, auth-gated,
// custody-gated, adopter re-resolved server-side, PO-gated placeholder terms,
// and — critically — a STATELESS read: no DB row of any kind from printing.
//
// Live-DB pattern mirrors __tests__/adoption-cascade.test.ts (admin client +
// session mock + withMutationOverride cleanup).

import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { dniLast4, hashDni } from "@/lib/utils/dni-hash";

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

const ADOPTER_EMAIL = "adopt-contract-adopter@dim-test.local";
const COORD_EMAIL = "adopt-contract-coord@dim-test.local";
const OUTSIDER_EMAIL = "adopt-contract-outsider@dim-test.local";
const PASS = "Contract_2026!";

const ORG_TOKEN = "DIM-CONTRACT-01";
const PET_TOKEN = "DIM-CONT-PET1";

const REGISTERED_DNI = "51000001"; // auth.users + profiles (dniVerified=false)
const STUB_DNI = "51000002"; // legacy stub — profiles only, no auth row
const ABSENT_DNI = "51000003"; // no profiles row

// The PO-gated marking — asserted VERBATIM. Changing this string is a PO
// decision (spec 3.4), so the test failing on a rewording is by design.
// PO decision 2026-08-07: model approved as orientative template (the
// pre-approval "TEXTO LEGAL PENDIENTE" draft marker retired).
const TERMS_PLACEHOLDER = "Modelo orientativo de miMAR — revisalo con tu organización";

let adopterUserId: string;
let coordUserId: string;
let outsiderUserId: string;
let stubProfileId: string;
let orgId: string;
let petId: string;

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

async function purgeStaleFixtures() {
  await withMutationOverride(async (tx) => {
    const stalePets = await tx
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, PET_TOKEN));
    for (const { id } of stalePets) {
      await tx.delete(notifications).where(eq(notifications.relatedPetId, id));
      await tx.delete(ownerships).where(eq(ownerships.petId, id));
      await tx.delete(petEvents).where(eq(petEvents.petId, id));
      await tx.delete(pets).where(eq(pets.id, id));
    }
    await tx.delete(profiles).where(eq(profiles.dniHash, hashDni(STUB_DNI)));
  });
  const staleOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.publicToken, ORG_TOKEN));
  for (const { id } of staleOrgs) {
    await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, id));
    await db.delete(organizations).where(eq(organizations.id, id));
  }
}

async function loadRoute() {
  return import("@/app/org/[orgToken]/mascotas/[publicToken]/adoption/contrato/route");
}

function contractRequest(body: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(body)) fd.set(k, v);
  return new Request(`http://test.local/org/${ORG_TOKEN}/mascotas/${PET_TOKEN}/adoption/contrato`, {
    method: "POST",
    body: fd,
  });
}

function routeParams(overrides: Partial<{ orgToken: string; publicToken: string }> = {}) {
  return {
    params: Promise.resolve({ orgToken: ORG_TOKEN, publicToken: PET_TOKEN, ...overrides }),
  };
}

async function totalEventCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(petEvents);
  return row?.n ?? 0;
}

async function totalProfileCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(profiles);
  return row?.n ?? 0;
}

beforeAll(async () => {
  await purgeStaleFixtures();
  for (const email of [ADOPTER_EMAIL, COORD_EMAIL, OUTSIDER_EMAIL]) {
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

  adopterUserId = await mkUser(ADOPTER_EMAIL);
  await db
    .update(profiles)
    .set({
      displayName: "Contrato Adoptante",
      dniHash: hashDni(REGISTERED_DNI),
      dniLast4: dniLast4(REGISTERED_DNI),
      dniVerified: false,
      role: "owner",
      accountType: "personal",
    })
    .where(eq(profiles.id, adopterUserId));

  coordUserId = await mkUser(COORD_EMAIL);
  await db
    .update(profiles)
    .set({ displayName: "Contrato Coord", role: "owner", accountType: "personal" })
    .where(eq(profiles.id, coordUserId));

  outsiderUserId = await mkUser(OUTSIDER_EMAIL);
  await db
    .update(profiles)
    .set({ displayName: "Contrato Outsider", role: "owner", accountType: "personal" })
    .where(eq(profiles.id, outsiderUserId));

  stubProfileId = randomUUID();
  await db.insert(profiles).values({
    id: stubProfileId,
    displayName: "Stub Contrato",
    dniHash: hashDni(STUB_DNI),
    dniLast4: dniLast4(STUB_DNI),
    dniVerified: false,
    role: "owner",
  });

  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN,
      legalName: "Contract Test Refugio SRL",
      displayName: "Contract Refugio",
      orgType: "shelter",
      email: "contract@dim-test.local",
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

  const now = new Date();
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "Contrata",
      species: "cat",
      sex: "female",
      potentiallyDangerousBreed: false,
      adoptionEligible: true,
      adoptionEligibilitySetAt: now,
    })
    .returning();
  petId = pet.id;

  await db.insert(ownerships).values({
    petId,
    ownerOrganizationId: orgId,
    role: "shelter_custody",
    startedAt: now,
  });
});

afterAll(async () => {
  await db.delete(notifications).where(eq(notifications.relatedPetId, petId));
  await db.delete(ownerships).where(eq(ownerships.petId, petId));
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(eq(petEvents.petId, petId));
    await tx.delete(pets).where(eq(pets.id, petId));
    await tx.delete(profiles).where(eq(profiles.id, stubProfileId));
  });
  await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  for (const email of [ADOPTER_EMAIL, COORD_EMAIL, OUTSIDER_EMAIL]) {
    await purgeUserByEmail(email);
  }
});

describe("printable adoption contract route (POST /adoption/contrato)", () => {
  it("exposes POST only — no GET (DNI must never ride a query string)", async () => {
    const mod = (await loadRoute()) as Record<string, unknown>;
    expect(typeof mod.POST).toBe("function");
    expect(mod.GET).toBeUndefined();
  });

  it("rejects a session without org membership (403)", async () => {
    mockSessionAs(outsiderUserId);
    const { POST } = await loadRoute();
    const res = await POST(contractRequest({ adopterDni: REGISTERED_DNI }), routeParams());
    expect(res.status).toBe(403);
  });

  it("rejects a pet that is not under this org's custody (404)", async () => {
    mockSessionAs(coordUserId);
    const { POST } = await loadRoute();
    const res = await POST(
      contractRequest({ adopterDni: REGISTERED_DNI }),
      routeParams({ publicToken: "DIM-NOPE-0000" }),
    );
    expect(res.status).toBe(404);
  });

  it("refuses an unregistered DNI — legacy stub and absent both 404", async () => {
    mockSessionAs(coordUserId);
    const { POST } = await loadRoute();

    const stubRes = await POST(contractRequest({ adopterDni: STUB_DNI }), routeParams());
    expect(stubRes.status).toBe(404);

    const absentRes = await POST(contractRequest({ adopterDni: ABSENT_DNI }), routeParams());
    expect(absentRes.status).toBe(404);
  });

  it("renders the contract for a registered adopter — placeholder terms verbatim, zero DB writes", async () => {
    mockSessionAs(coordUserId);
    const eventsBefore = await totalEventCount();
    const profilesBefore = await totalProfileCount();

    const { POST } = await loadRoute();
    const res = await POST(
      contractRequest({
        adopterDni: REGISTERED_DNI,
        followupMonths: "6",
        notes: "Cláusula de prueba",
      }),
      routeParams(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    // Inline print view — never a .pdf download claim (libreta-export contract).
    expect(res.headers.get("Content-Disposition")).toBeNull();

    const html = await res.text();
    // PO-gated draft marking, unmissable and verbatim (spec 3.4).
    expect(html).toContain(TERMS_PLACEHOLDER);
    expect(html).toContain("Modelo orientativo — adaptalo a tu organización");
    // Org / adopter / pet / date / notes / followup blocks.
    expect(html).toContain("Contract Refugio");
    expect(html).toContain("Contrato Adoptante");
    expect(html).toContain(REGISTERED_DNI);
    expect(html).toContain("Contrata");
    expect(html).toContain(PET_TOKEN);
    expect(html).toContain("Cláusula de prueba");
    expect(html).toContain("6 meses");
    // Print trigger — the browser produces the PDF, not the server.
    expect(html).toContain("window.print()");

    // Stateless read (spec 3.5): printing wrote NOTHING anywhere.
    expect(await totalEventCount()).toBe(eventsBefore);
    expect(await totalProfileCount()).toBe(profilesBefore);
  });
});
