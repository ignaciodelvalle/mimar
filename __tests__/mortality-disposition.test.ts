// Integration tests for lib/mortality-metrics → fetchMortalityDisposition.
//
// Item 2 — Mortality & disposal dashboard (/gob/mortalidad). Pure projection
// over death_recorded events. Seeds ephemeral pets + death_recorded events into
// local Postgres and asserts B2/B3/B4/B7/B9 values, plus the two mandatory
// privacy/scope cases required by the umbrella (§5):
//   - k-anonymity: a locality with < 5 deaths is suppressed/rolled to province.
//   - jurisdiction scope: deaths outside the viewer's jurisdiction don't leak in.
//
// Seeding mirrors __tests__/govt-dashboards.test.ts: insertFixturePet writes a
// pets + ownerships row; death_recorded events are appended directly; cleanup
// uses the pet_events append-only escape hatch (withMutationOverride).

import { createClient } from "@supabase/supabase-js";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, petEvents, pets, profiles } from "@/db";
import {
  fetchMortalityDisposition,
  rollupSuppressedLocalities,
} from "@/lib/analytics/mortality-metrics";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { buildProjectionContext } from "@/lib/metrics";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const OWNER_EMAIL = "mortality-dash-owner@dim-test.local";
let ownerUserId: string;

const TEST_PET_TOKEN_PREFIX = "MORT-TEST-";

const DAY_MS = 24 * 60 * 60 * 1000;
const since = new Date(Date.now() - 365 * DAY_MS);
const until = new Date();

/** Build a ProjectionContext over a fixed trailing-12m window. */
function ctxFor(
  actor: { role: "admin" | "govt" },
  jurisdictions: Array<{ province: string; locality: string }>,
) {
  return buildProjectionContext(actor, jurisdictions, { since, until });
}

async function ensureOwner(): Promise<string> {
  const { data: list } = await adminSdk.auth.admin.listUsers({ perPage: 200 });
  const existing = list?.users.find((u) => u.email === OWNER_EMAIL);
  if (existing) {
    const [profile] = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.id, existing.id));
    if (profile) return existing.id;
    await adminSdk.auth.admin.deleteUser(existing.id);
  }
  const r = await createFreshTestUser(adminSdk, {
    email: OWNER_EMAIL,
    password: "MortalityDashTest_2026!",
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser: ${r.error?.message}`);
  return r.data.user.id;
}

async function cleanupFixtureRows() {
  const fixturePets = await db
    .select({ id: pets.id })
    .from(pets)
    .where(sql`${pets.publicToken} LIKE ${`${TEST_PET_TOKEN_PREFIX}%`}`);
  const ids = fixturePets.map((p) => p.id);
  if (ids.length === 0) return;
  // pet_events has a BEFORE DELETE trigger; the override GUC is the escape hatch.
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(inArray(petEvents.petId, ids));
  });
  await db.delete(ownerships).where(inArray(ownerships.petId, ids));
  await db.delete(pets).where(inArray(pets.id, ids));
}

async function insertFixturePet(input: {
  province: string;
  locality: string;
}): Promise<string> {
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: `${TEST_PET_TOKEN_PREFIX}${generatePublicToken().slice(5)}`,
      name: "Fixture",
      species: "dog",
      jurisdictionProvince: input.province,
      jurisdictionLocality: input.locality,
      status: "deceased",
    })
    .returning({ id: pets.id });
  await db.insert(ownerships).values({ petId: row.id, ownerUserId, role: "owner" });
  return row.id;
}

type DeathInput = {
  province: string;
  locality: string;
  cause?: string;
  dispositionMethod?: string | null;
  facility?: string | null;
  confirmedByVet?: boolean;
  deathAtClinic?: boolean;
  ownerToPrivateCrematorium?: boolean;
  isReportable?: boolean;
  diseaseCode?: string | null;
  daysAgo?: number;
};

/** Seed one pet + one death_recorded event for it. */
async function seedDeath(input: DeathInput) {
  const petId = await insertFixturePet({ province: input.province, locality: input.locality });
  await db.insert(petEvents).values({
    petId,
    eventType: "death_recorded",
    occurredAt: new Date(Date.now() - (input.daysAgo ?? 10) * DAY_MS),
    payload: {
      payload_version: 1,
      cause: input.cause ?? "natural",
      cause_detail: null,
      confirmed_by_vet: input.confirmedByVet ? true : null,
      vet_name: null,
      disposition_method:
        input.dispositionMethod === undefined ? "cremation_collective" : input.dispositionMethod,
      facility: input.facility === undefined ? "Crematorio Test" : input.facility,
      death_at_clinic: input.deathAtClinic ? true : null,
      clinic_name: null,
      vet_contacted_owner: null,
      vet_decided_alone: null,
      owner_to_private_crematorium: input.ownerToPrivateCrematorium ? true : null,
      disease_code: input.diseaseCode ?? null,
      confirmed_by_lab: null,
      is_reportable: input.isReportable ?? false,
    },
    authorRole: "system",
    recordedByUserId: null,
  });
  return petId;
}

beforeAll(async () => {
  ownerUserId = await ensureOwner();
  await cleanupFixtureRows();
});

afterEach(cleanupFixtureRows);

const CABA = { province: "CABA", locality: "CABA" };

describe("fetchMortalityDisposition — B2 disposition mix + B3 traceable rate", () => {
  it("computes bucket shares and traceable-disposal rate", async () => {
    // 2 cremation, 1 home burial, 1 authorized burial, 1 rendering (all traceable) = 5 deaths.
    await seedDeath({ ...CABA, dispositionMethod: "cremation_collective", facility: "Crem A" });
    await seedDeath({
      ...CABA,
      dispositionMethod: "cremation_individual_ashes",
      facility: "Crem B",
    });
    await seedDeath({ ...CABA, dispositionMethod: "owner_burial", facility: "Patio" });
    await seedDeath({ ...CABA, dispositionMethod: "authorized_cemetery", facility: "Cementerio" });
    await seedDeath({ ...CABA, dispositionMethod: "rendering", facility: "Planta" });

    const r = await fetchMortalityDisposition(ctxFor({ role: "govt" }, [CABA]));

    expect(r.total).toBe(5);
    const byBucket = Object.fromEntries(r.byBucket.map((b) => [b.bucket, b.count]));
    expect(byBucket.cremation).toBe(2);
    // The burial buckets are split (S4): a backyard burial must never hide
    // inside the same bar as a compliant authorized cemetery.
    expect(byBucket.home_burial).toBe(1);
    expect(byBucket.authorized_burial).toBe(1);
    expect(byBucket.burial).toBeUndefined();
    expect(byBucket.rendering).toBe(1);
    // All 4 have a known method + facility → traceable rate = 100%.
    expect(r.traceableRate).toBe(100);
  });
});

describe("fetchMortalityDisposition — B4 unknown-disposition rate", () => {
  it("counts null/unknown disposition in B4 and excludes it from the B3 numerator", async () => {
    // 2 traceable, 2 untraceable (1 null method, 1 'unknown') = 4 deaths, 50% unknown.
    await seedDeath({ ...CABA, dispositionMethod: "cremation_collective", facility: "Crem A" });
    await seedDeath({ ...CABA, dispositionMethod: "authorized_cemetery", facility: "Cementerio" });
    await seedDeath({ ...CABA, dispositionMethod: null, facility: null });
    await seedDeath({ ...CABA, dispositionMethod: "unknown", facility: "Ignored" });

    const r = await fetchMortalityDisposition(ctxFor({ role: "govt" }, [CABA]));

    expect(r.total).toBe(4);
    expect(r.unknownRate).toBe(50);
    // Only the 2 known+facility deaths are traceable.
    expect(r.traceableRate).toBe(50);
  });
});

describe("fetchMortalityDisposition — B9 reportable-death share", () => {
  it("computes reportable share and disease_code breakdown", async () => {
    await seedDeath({ ...CABA, isReportable: true, diseaseCode: "rabies" });
    await seedDeath({ ...CABA, isReportable: true, diseaseCode: "rabies" });
    await seedDeath({ ...CABA, isReportable: true, diseaseCode: "leptospirosis" });
    await seedDeath({ ...CABA, isReportable: false, diseaseCode: null });

    const r = await fetchMortalityDisposition(ctxFor({ role: "govt" }, [CABA]));

    expect(r.total).toBe(4);
    expect(r.reportableShare).toBe(75);
    const byCode = Object.fromEntries(r.reportableByCode.map((c) => [c.code, c.count]));
    expect(byCode.rabies).toBe(2);
    expect(byCode.leptospirosis).toBe(1);
  });
});

describe("fetchMortalityDisposition — B7 disposal-context splits", () => {
  it("computes vet-confirmed / at-clinic / private-crematorium shares", async () => {
    await seedDeath({ ...CABA, confirmedByVet: true, deathAtClinic: true });
    await seedDeath({ ...CABA, confirmedByVet: true, ownerToPrivateCrematorium: true });
    await seedDeath({ ...CABA });
    await seedDeath({ ...CABA });

    const r = await fetchMortalityDisposition(ctxFor({ role: "govt" }, [CABA]));

    expect(r.total).toBe(4);
    expect(r.contextSplits.vetConfirmedRate).toBe(50);
    expect(r.contextSplits.deathAtClinicRate).toBe(25);
    expect(r.contextSplits.privateCrematoriumRate).toBe(25);
  });
});

describe("fetchMortalityDisposition — k-anonymity (mandatory)", () => {
  it("suppresses a locality with < 5 deaths and rolls it to the province bucket", async () => {
    // Locality A: 5 deaths (>= k → visible). Locality B: 3 deaths (< k → suppressed).
    // Synthetic localities so only THIS test's deaths count — real ones (La Plata,
    // Quilmes) are populated by the national demo seed, which would push the
    // "suppressed" locality over the k threshold.
    const provincia = "Buenos Aires";
    const locVisible = `kanon-visible-${Date.now()}`;
    const locSuppressed = `kanon-suppressed-${Date.now()}`;
    for (let i = 0; i < 5; i++) {
      await seedDeath({ province: provincia, locality: locVisible });
    }
    for (let i = 0; i < 3; i++) {
      await seedDeath({ province: provincia, locality: locSuppressed });
    }

    // Scope the viewer to exactly these two assignments so the population is
    // bounded to this test's fixtures (an admin universal scope could otherwise
    // pick up unrelated fixture rows left by other test files in the suite).
    const r = await fetchMortalityDisposition(
      ctxFor({ role: "govt" }, [
        { province: provincia, locality: locVisible },
        { province: provincia, locality: locSuppressed },
      ]),
    );

    const localities = r.byLocality.value.map((c) => c.key);
    expect(localities).toContain(locVisible);
    expect(localities).not.toContain(locSuppressed);
    // The suppressed cell is still REPORTED — as a count of hidden localities,
    // which discloses nothing about how many deaths they hold.
    expect(r.byLocality.suppressedCount).toBe(1);
    const visible = r.byLocality.value.find((c) => c.key === locVisible);
    expect(visible?.count).toBe(5);

    // THIS ASSERTION USED TO READ `expect(rolled?.count).toBe(3)`, and it was
    // pinning the leak. One suppressed locality of 3 folded into a row labelled
    // "Buenos Aires (otras localidades) — 3" is that locality's exact count,
    // relabelled — on a page whose accessible description promises localities
    // under 5 are hidden. Live review 2026-07-28 read it off /gob/mortalidad as
    // "Tierra del Fuego (otras localidades) — 2".
    //
    // The rollup is a published cell, so k applies to it too: below k there is
    // no row at all.
    const rolled = r.byLocality.value.find((c) => c.key.includes(provincia));
    expect(rolled).toBeUndefined();
  });

  it("publishes the rollup once the FOLD itself reaches k", () => {
    // The counterpart the suite lacked: suppression must not become blanket
    // deletion. Three sub-k localities (2+2+2) sum to 6, and a fold of six
    // deaths across three places identifies nobody — it is exactly what the
    // rollup exists to preserve. Asserted through the pure builder so the case
    // does not depend on the seed happening to contain three sparse localities.
    const rolled = rollupSuppressedLocalities([
      { key: "a", count: 2, province: "Buenos Aires" } as never,
      { key: "b", count: 2, province: "Buenos Aires" } as never,
      { key: "c", count: 2, province: "Buenos Aires" } as never,
    ]);
    expect(rolled?.count).toBe(6);
    expect(rolled?.key).toBe("Buenos Aires (otras localidades)");
  });
});

describe("fetchMortalityDisposition — jurisdiction scope (mandatory)", () => {
  it("does not leak deaths from another province to a locality-scoped govt viewer", async () => {
    // 2 deaths in CABA (in scope), 3 deaths in Buenos Aires (out of scope).
    await seedDeath({ ...CABA });
    await seedDeath({ ...CABA });
    await seedDeath({ province: "Buenos Aires", locality: "La Plata" });
    await seedDeath({ province: "Buenos Aires", locality: "La Plata" });
    await seedDeath({ province: "Buenos Aires", locality: "La Plata" });

    const r = await fetchMortalityDisposition(ctxFor({ role: "govt" }, [CABA]));

    // Only the 2 CABA deaths are visible to a CABA-scoped viewer.
    expect(r.total).toBe(2);
    const localities = r.byLocality.value.map((c) => c.key);
    expect(localities).not.toContain("La Plata");
  });
});
