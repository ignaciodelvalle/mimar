// Integration tests for scripts/migrate-vets-to-clinics.ts (Sprint 1A Phase A).
//
// Spins up a vet via the admin SDK (so handle_new_user fires and the
// profile row lands), promotes the profile to role=vet + matriculaVerified,
// inserts a couple of orphan service offerings, then exercises migrateOne /
// migrateAll against the live local DB. Each test cleans up its own fixture.

import { createClient } from "@supabase/supabase-js";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, organizationMemberships, organizations, profiles, serviceOfferings } from "@/db";
import { migrateOne } from "../scripts/migrate-vets-to-clinics";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const VET_EMAIL = "migrate-vets-test@dim-test.local";
const PASS = "MigrateVets_2026!";

let vetUserId: string;

async function purgeVet() {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === VET_EMAIL);
  if (!found) return;

  // Drop offerings + membership + auto-created clinic + profile so the vet
  // is fully removable. Order: offerings → membership → org → notifications
  // → profile → auth user.
  const ownedOfferings = await db
    .select({ id: serviceOfferings.id })
    .from(serviceOfferings)
    .where(eq(serviceOfferings.providerUserId, found.id));
  for (const o of ownedOfferings) {
    await db.delete(serviceOfferings).where(eq(serviceOfferings.id, o.id));
  }

  const autoOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.createdByUserId, found.id));
  for (const o of autoOrgs) {
    await db.delete(serviceOfferings).where(eq(serviceOfferings.organizationId, o.id));
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.organizationId, o.id));
    await db.delete(organizations).where(eq(organizations.id, o.id));
  }

  // profile delete cascades to pet_events.recorded_by_user_id (SET NULL) —
  // wrap so the append-only trigger doesn't block the cascade if a prior
  // test left referencing events behind.
  await withMutationOverride(async (tx) => {
    await tx.delete(profiles).where(eq(profiles.id, found.id));
  });
  await admin.auth.admin.deleteUser(found.id);
}

async function provisionVet(): Promise<string> {
  const { data, error } = await createFreshTestUser(admin, {
    email: VET_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  vetUserId = data.user.id;

  await db
    .update(profiles)
    .set({
      role: "vet",
      matriculaNumber: "MN-12345",
      matriculaJurisdiccion: "Buenos Aires",
      matriculaVerified: true,
      displayName: "Dra Test",
    })
    .where(eq(profiles.id, vetUserId));

  return vetUserId;
}

async function insertOrphanOffering(suffix: string) {
  const [row] = await db
    .insert(serviceOfferings)
    .values({
      publicToken: `SVO-MIGRATE-${suffix}-${Date.now()}`,
      providerUserId: vetUserId,
      jurisdictionCountry: "AR",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      serviceKind: "vaccination",
      displayName: `Vacunación ${suffix}`,
      status: "approved",
    })
    .returning({ id: serviceOfferings.id });
  return row.id;
}

beforeEach(async () => {
  await purgeVet();
  await provisionVet();
});

afterEach(async () => {
  await purgeVet();
});

describe("migrate-vets-to-clinics — happy path", () => {
  it("creates a clinic org, vet admin membership, and re-anchors all orphan offerings", async () => {
    const o1 = await insertOrphanOffering("A");
    const o2 = await insertOrphanOffering("B");

    const result = await migrateOne({ id: vetUserId, displayName: "Dra Test" });

    expect(result.kind).toBe("migrated");
    if (result.kind !== "migrated") throw new Error("expected migrated");
    expect(result.offeringsReanchored).toBe(2);

    const [org] = await db.select().from(organizations).where(eq(organizations.id, result.orgId));
    expect(org).toBeDefined();
    expect(org.orgType).toBe("clinic");
    expect(org.displayName).toBe("Consultorio Dra Test");
    expect(org.legalName).toBe("Consultorio Dra Test");
    expect(org.status).toBe("active");
    expect(org.verified).toBe(true);
    expect(org.verifiedAt).toBeInstanceOf(Date);
    expect(org.createdByUserId).toBe(vetUserId);
    expect(org.jurisdictionProvince).toBe("Buenos Aires");
    expect(org.jurisdictionLocality).toBe("La Plata");
    expect(org.publicToken).toMatch(/^DIM-/);

    const [membership] = await db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, result.orgId),
          eq(organizationMemberships.userId, vetUserId),
        ),
      );
    expect(membership).toBeDefined();
    expect(membership.role).toBe("admin");
    expect(membership.canWritePetEvents).toBe(true);

    const [off1, off2] = await db
      .select({
        id: serviceOfferings.id,
        orgId: serviceOfferings.organizationId,
        vetId: serviceOfferings.providerUserId,
      })
      .from(serviceOfferings)
      .where(eq(serviceOfferings.id, o1))
      .union(
        db
          .select({
            id: serviceOfferings.id,
            orgId: serviceOfferings.organizationId,
            vetId: serviceOfferings.providerUserId,
          })
          .from(serviceOfferings)
          .where(eq(serviceOfferings.id, o2)),
      );

    for (const off of [off1, off2]) {
      expect(off.orgId).toBe(result.orgId);
      // XOR constraint forces providerUserId to NULL when organizationId is set.
      expect(off.vetId).toBeNull();
    }
  });
});

describe("migrate-vets-to-clinics — idempotency", () => {
  it("second run is a no-op for a vet whose clinic already exists", async () => {
    await insertOrphanOffering("X");

    const first = await migrateOne({ id: vetUserId, displayName: "Dra Test" });
    expect(first.kind).toBe("migrated");

    const second = await migrateOne({ id: vetUserId, displayName: "Dra Test" });
    expect(second.kind).toBe("skipped_existing");
    if (second.kind !== "skipped_existing") throw new Error("expected skipped_existing");
    expect(second.stragglerOfferingsReanchored).toBe(0);

    // Still exactly one clinic for this vet.
    const orgs = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(eq(organizations.createdByUserId, vetUserId), eq(organizations.orgType, "clinic")),
      );
    expect(orgs).toHaveLength(1);
  });

  it("re-anchors a straggler offering if one shows up after the clinic was created", async () => {
    await insertOrphanOffering("first");
    const first = await migrateOne({ id: vetUserId, displayName: "Dra Test" });
    if (first.kind !== "migrated") throw new Error("expected migrated");
    const orgId = first.orgId;

    // A new orphan offering shows up after the initial migration (simulates a
    // partially-failed earlier run or a vet who added an offering with the
    // old code path).
    const straggler = await insertOrphanOffering("straggler");

    const second = await migrateOne({ id: vetUserId, displayName: "Dra Test" });
    expect(second.kind).toBe("skipped_existing");
    if (second.kind !== "skipped_existing") throw new Error("expected skipped_existing");
    expect(second.stragglerOfferingsReanchored).toBe(1);

    const [off] = await db
      .select({ orgId: serviceOfferings.organizationId, vetId: serviceOfferings.providerUserId })
      .from(serviceOfferings)
      .where(eq(serviceOfferings.id, straggler));
    expect(off.orgId).toBe(orgId);
    expect(off.vetId).toBeNull();
  });
});

describe("migrate-vets-to-clinics — edge cases", () => {
  it("skips a vet with zero orphan offerings", async () => {
    const result = await migrateOne({ id: vetUserId, displayName: "Dra Test" });
    expect(result.kind).toBe("skipped_no_offerings");

    const orgs = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.createdByUserId, vetUserId));
    expect(orgs).toHaveLength(0);
  });

  it("dry-run reports the expected outcome without writing anything", async () => {
    await insertOrphanOffering("dry");

    const result = await migrateOne({ id: vetUserId, displayName: "Dra Test" }, { dryRun: true });
    expect(result.kind).toBe("migrated");

    // No org created.
    const orgs = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.createdByUserId, vetUserId));
    expect(orgs).toHaveLength(0);

    // Offering untouched.
    const offerings = await db
      .select({ vetId: serviceOfferings.providerUserId, orgId: serviceOfferings.organizationId })
      .from(serviceOfferings)
      .where(
        and(
          eq(serviceOfferings.providerUserId, vetUserId),
          isNull(serviceOfferings.organizationId),
        ),
      );
    expect(offerings).toHaveLength(1);
  });
});
