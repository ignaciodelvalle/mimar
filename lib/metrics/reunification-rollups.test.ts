// Integration tests for lib/metrics/reunification-rollups.ts (D4 per-unit rate).
//
// Mirrors the fixture pattern of __tests__/compliance-enforcement.test.ts
// (fetchReunificationRate's national-level sibling): seeds into UNIQUE test
// jurisdictions on the shared dev DB, asserts via a GOVT-scoped ProjectionContext
// so the scope filter isolates our fixtures from concurrent test runs.
//
// Covers the REGRESSION the plan calls out explicitly: k-anon suppression must
// key off lostEpisodes (the denominator), never off ratePct. A unit with few
// lost episodes and a 100% rate is exactly as re-identifiable as one with a 0%
// rate — suppressing on the rate value would get this backwards.

import { createClient } from "@supabase/supabase-js";
import { inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { withMutationOverride } from "@/__tests__/_helpers/db-overrides";
import { createFreshTestUser } from "@/__tests__/_helpers/fresh-test-user";
import { db, ownerships, petEvents, pets, profiles } from "@/db";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";
import { fetchReunificationByUnit } from "@/lib/metrics/reunification-rollups";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

// Unique test jurisdiction — La Pampa is real, low-traffic; locality names are
// unique to this file so govt-scoped counts stay deterministic on the shared DB.
const PROV = "La Pampa";
const LOC_A = "RR-LOC-A-uniq";
const LOC_B = "RR-LOC-B-uniq";
// Two REAL La Pampa localities that INDEC folds into the SAME department
// (Caleu Caleu, 42014) — used to prove the Option-A department fold: each is
// below k=5 alone, but folded together they clear it (item #4).
const LOC_DEPT_1 = "Anzoátegui";
const LOC_DEPT_2 = "La Adela";
const DEPT_NAME = "Caleu Caleu";
const DEPT_CODE = "42014";
const TOKEN_PREFIX = "RR-TEST-";
const OWNER_EMAIL = "reunification-rollups-owner@dim-test.local";

const DAY_MS = 24 * 60 * 60 * 1000;

let ownerUserId: string;

function govtCtx(
  jurisdictions: Array<{ province: string; locality: string }>,
  period = windows.trailing12m(),
) {
  return buildProjectionContext({ role: "govt" }, jurisdictions, period);
}

async function ensureOwner(): Promise<string> {
  const { data: list } = await adminSdk.auth.admin.listUsers({ perPage: 200 });
  const existing = list?.users.find((u) => u.email === OWNER_EMAIL);
  if (existing) {
    const [profile] = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(sql`${profiles.id} = ${existing.id}`);
    if (profile) return existing.id;
    await adminSdk.auth.admin.deleteUser(existing.id);
  }
  const r = await createFreshTestUser(adminSdk, {
    email: OWNER_EMAIL,
    password: "ReunificationRollupsTest_2026!",
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser: ${r.error?.message}`);
  return r.data.user.id;
}

async function cleanupFixtures() {
  const fixturePets = await db
    .select({ id: pets.id })
    .from(pets)
    .where(sql`${pets.publicToken} LIKE ${`${TOKEN_PREFIX}%`}`);
  const ids = fixturePets.map((p) => p.id);
  if (ids.length === 0) return;
  // pet_events has a BEFORE DELETE trigger; the GUC override is the escape hatch.
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(inArray(petEvents.petId, ids));
  });
  await db.delete(ownerships).where(inArray(ownerships.petId, ids));
  await db.delete(pets).where(inArray(pets.id, ids));
}

async function insertPet(input: { province: string; locality: string }): Promise<string> {
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: `${TOKEN_PREFIX}${generatePublicToken().slice(4)}`,
      name: "RRTestPet",
      species: "dog",
      jurisdictionProvince: input.province,
      jurisdictionLocality: input.locality,
      status: "active",
    })
    .returning({ id: pets.id });
  await db.insert(ownerships).values({ petId: row.id, ownerUserId, role: "owner" });
  return row.id;
}

async function emitStatusChange(
  petId: string,
  toStatus: "lost" | "active" | "deceased",
  occurredAt: Date,
) {
  await db.insert(petEvents).values({
    petId,
    eventType: "status_changed",
    occurredAt,
    payload: { payload_version: 1, from_status: "active", to_status: toStatus },
    authorRole: "system",
    recordedByUserId: null,
  });
}

beforeAll(async () => {
  ownerUserId = await ensureOwner();
  await cleanupFixtures();
});

afterEach(cleanupFixtures);
afterAll(cleanupFixtures);

describe("fetchReunificationByUnit — locality level", () => {
  it("computes ratePct = recovered/lostEpisodes per unit; deceased excluded from recovered", async () => {
    // LOC_A: 5 lost episodes (>= k=5) so the unit clears k-anon and is visible.
    // 2 recovered, 1 still lost, 1 deceased (must not count as recovered), 1 lost-only.
    const recovered1 = await insertPet({ province: PROV, locality: LOC_A });
    await emitStatusChange(recovered1, "lost", new Date(Date.now() - 10 * DAY_MS));
    await emitStatusChange(recovered1, "active", new Date(Date.now() - 4 * DAY_MS));

    const recovered2 = await insertPet({ province: PROV, locality: LOC_A });
    await emitStatusChange(recovered2, "lost", new Date(Date.now() - 9 * DAY_MS));
    await emitStatusChange(recovered2, "active", new Date(Date.now() - 2 * DAY_MS));

    const stillLost = await insertPet({ province: PROV, locality: LOC_A });
    await emitStatusChange(stillLost, "lost", new Date(Date.now() - 8 * DAY_MS));

    const deceased = await insertPet({ province: PROV, locality: LOC_A });
    await emitStatusChange(deceased, "lost", new Date(Date.now() - 7 * DAY_MS));
    await emitStatusChange(deceased, "deceased", new Date(Date.now() - 3 * DAY_MS));

    const lostOnly = await insertPet({ province: PROV, locality: LOC_A });
    await emitStatusChange(lostOnly, "lost", new Date(Date.now() - 6 * DAY_MS));

    const result = await fetchReunificationByUnit(
      govtCtx([{ province: PROV, locality: LOC_A }]),
      "locality",
    );

    const unit = result.byUnit.find((u) => u.locality === LOC_A);
    expect(unit).toBeDefined();
    // 2 recovered / 5 lost episodes = 40%.
    expect(unit?.ratePct).toBe(40);
    expect(result.suppressedCount).toBe(0);
  });

  it("k-anon suppresses on lostEpisodes (denominator), NOT on ratePct — regression guard", async () => {
    // LOC_B: only 2 lost episodes (< k=5) — BOTH recovered, a 100% rate. If
    // suppression keyed off ratePct (the stash bug this module fixes), a
    // small-population 100% rate would slip through unsuppressed. It must not:
    // the unit is k-anon suppressed and counted in suppressedCount.
    const a = await insertPet({ province: PROV, locality: LOC_B });
    await emitStatusChange(a, "lost", new Date(Date.now() - 5 * DAY_MS));
    await emitStatusChange(a, "active", new Date(Date.now() - 1 * DAY_MS));

    const b = await insertPet({ province: PROV, locality: LOC_B });
    await emitStatusChange(b, "lost", new Date(Date.now() - 5 * DAY_MS));
    await emitStatusChange(b, "active", new Date(Date.now() - 1 * DAY_MS));

    const result = await fetchReunificationByUnit(
      govtCtx([{ province: PROV, locality: LOC_B }]),
      "locality",
    );

    // KA6: the suppressed unit is EMITTED as a `suppressed:true` cell (the honest
    // hatch category every other layer uses) — NOT dropped to plain no-data. But
    // the real value never leaves the module: ratePct is a 0 placeholder, so the
    // 100% small-population rate is NOT exposed and suppression still keyed off the
    // lostEpisodes denominator (2 < k=5), not the rate.
    const unit = result.byUnit.find((u) => u.locality === LOC_B);
    expect(unit).toBeDefined();
    expect(unit?.suppressed).toBe(true);
    // NULL, never 0 (#40b). A 0 placeholder asserts "0% recuperadas" — a lie that
    // is also indistinguishable from a real measurement.
    expect(unit?.ratePct).toBeNull();
    expect(result.suppressedCount).toBeGreaterThanOrEqual(1);
  });

  it("FOLDS member localities up to their department (Option A) before rate + k-anon", async () => {
    // 3 lost in Anzoátegui + 2 lost in La Adela: each locality is below k=5 alone
    // (pre-fold both would suppress), but they fold into ONE department (Caleu
    // Caleu) whose 5-episode denominator clears k=5. The unit is labeled by the
    // DEPARTMENT, carries its INDEC code, and resolves a folded centroid.
    for (let i = 0; i < 3; i++) {
      const p = await insertPet({ province: PROV, locality: LOC_DEPT_1 });
      await emitStatusChange(p, "lost", new Date(Date.now() - (10 + i) * DAY_MS));
      if (i === 0) await emitStatusChange(p, "active", new Date(Date.now() - 2 * DAY_MS));
    }
    for (let i = 0; i < 2; i++) {
      const p = await insertPet({ province: PROV, locality: LOC_DEPT_2 });
      await emitStatusChange(p, "lost", new Date(Date.now() - (9 + i) * DAY_MS));
      if (i === 0) await emitStatusChange(p, "active", new Date(Date.now() - 1 * DAY_MS));
    }

    const result = await fetchReunificationByUnit(
      govtCtx([
        { province: PROV, locality: LOC_DEPT_1 },
        { province: PROV, locality: LOC_DEPT_2 },
      ]),
      "locality",
    );

    // Both member localities collapse into a SINGLE department-grain unit — no
    // bare-locality holdouts survive the fold.
    expect(result.byUnit).toHaveLength(1);
    const unit = result.byUnit[0];
    expect(unit.locality).toBe(DEPT_NAME);
    expect(unit.departmentCode).toBe(DEPT_CODE);
    // The folded department clears k=5 (5 lost episodes) — nothing suppressed.
    expect(result.suppressedCount).toBe(0);
    // Folded centroid resolved from the member localities' ar_localities rows.
    expect(unit.centroidLat).not.toBeNull();
    expect(unit.centroidLng).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PROVINCE LEVEL — task #40b.
//
// This block used to contain ONE test asserting the opposite of everything below:
// "never suppresses at province level, even for a small lostEpisodes count". It
// did not pin a behaviour, it DEFENDED a leak — the Santa Cruz case task #40 was
// named after. THE RATE REVEALS THE DENOMINATOR: one lost episode plus one
// recovery published "100%", a public statement about one identifiable animal.
// ---------------------------------------------------------------------------
describe("fetchReunificationByUnit — province level", () => {
  /** Seed `lostEpisodes` lost episodes in PROV, of which `recovered` return to active. */
  async function seedProvince(lostEpisodes: number, recovered: number) {
    for (let i = 0; i < lostEpisodes; i++) {
      const p = await insertPet({ province: PROV, locality: LOC_B });
      await emitStatusChange(p, "lost", new Date(Date.now() - (20 + i) * DAY_MS));
      if (i < recovered)
        await emitStatusChange(p, "active", new Date(Date.now() - (5 + i) * DAY_MS));
    }
    return fetchReunificationByUnit(govtCtx([{ province: PROV, locality: LOC_B }]), "province");
  }

  it("suppresses a province BELOW k — and publishes null, never a rate or a zero", async () => {
    // 1 lost episode, 1 recovery: the leak verbatim. ratePct would be 100.
    const result = await seedProvince(1, 1);

    const unit = result.byUnit.find((u) => u.province === PROV);
    expect(unit).toBeDefined();
    expect(unit?.suppressed).toBe(true);
    // The whole point: no rate escapes. Not 100, and not a 0 stand-in either.
    expect(unit?.ratePct).toBeNull();
    // Emitted, NOT dropped — a cell that vanishes makes absence the disclosure.
    expect(unit?.locality).toBeNull();
  });

  it("suppresses at k-1 = 4 lost episodes (the last protected denominator)", async () => {
    const result = await seedProvince(4, 2);

    const unit = result.byUnit.find((u) => u.province === PROV);
    expect(unit?.suppressed).toBe(true);
    expect(unit?.ratePct).toBeNull();
  });

  it("does NOT suppress at EXACTLY k = 5 — the boundary is `>= k`, not `> k`", async () => {
    // 5 lost episodes, 2 recovered → 40%. One episode fewer and this is protected;
    // an off-by-one in the comparison would silently withhold every k-sized cell.
    const result = await seedProvince(5, 2);

    const unit = result.byUnit.find((u) => u.province === PROV);
    expect(unit).toBeDefined();
    expect(unit?.suppressed).toBeUndefined();
    expect(unit?.ratePct).toBe(40);
    expect(result.suppressedCount).toBe(0);
  });

  it("reports suppressedCount — suppressing without disclosing is the #40 follow-up bug", async () => {
    // Hiding the cell is only half the job: the console's "N unidades suprimidas
    // por k-anonimato" line reads this number. A suppressed cell alongside
    // suppressedCount: 0 hides data and tells nobody.
    const result = await seedProvince(3, 3);

    expect(result.suppressedCount).toBe(1);
    expect(result.byUnit.filter((u) => u.suppressed)).toHaveLength(result.suppressedCount);
  });

  it("keys suppression off the DENOMINATOR, never the rate — a 0% sub-k province is protected too", async () => {
    // The mirror of the 100% case. Suppressing on `ratePct` would leave this one
    // visible (0 is not a suspicious-looking number) while hiding the 100% twin —
    // exactly backwards: both describe the same 2 identifiable animals.
    const result = await seedProvince(2, 0);

    const unit = result.byUnit.find((u) => u.province === PROV);
    expect(unit?.suppressed).toBe(true);
    expect(unit?.ratePct).toBeNull();
  });

  it("never publishes a ratePct over a sub-k denominator, across a mixed scope", async () => {
    // PROV clears k (5 episodes); a second province carries 2. The invariant is
    // global: every row that carries a number must have had >= k episodes behind it.
    const OTHER = "La Rioja";
    for (let i = 0; i < 5; i++) {
      const p = await insertPet({ province: PROV, locality: LOC_B });
      await emitStatusChange(p, "lost", new Date(Date.now() - (20 + i) * DAY_MS));
      if (i < 3) await emitStatusChange(p, "active", new Date(Date.now() - (5 + i) * DAY_MS));
    }
    for (let i = 0; i < 2; i++) {
      const p = await insertPet({ province: OTHER, locality: LOC_A });
      await emitStatusChange(p, "lost", new Date(Date.now() - (20 + i) * DAY_MS));
      await emitStatusChange(p, "active", new Date(Date.now() - (5 + i) * DAY_MS));
    }

    const result = await fetchReunificationByUnit(
      govtCtx([
        { province: PROV, locality: LOC_B },
        { province: OTHER, locality: LOC_A },
      ]),
      "province",
    );

    const big = result.byUnit.find((u) => u.province === PROV);
    const small = result.byUnit.find((u) => u.province === OTHER);
    expect(big?.ratePct).toBe(60);
    expect(big?.suppressed).toBeUndefined();
    // OTHER would have published 100% over two animals.
    expect(small?.suppressed).toBe(true);
    expect(small?.ratePct).toBeNull();
    expect(result.suppressedCount).toBe(1);
    // The invariant, stated directly: a published number implies a cleared cell.
    for (const u of result.byUnit) {
      if (u.ratePct !== null) expect(u.suppressed).not.toBe(true);
    }
  });
});

describe("fetchReunificationByUnit — scope guard", () => {
  it("returns the empty shape for govt with no jurisdictions, without hitting DB", async () => {
    const result = await fetchReunificationByUnit(govtCtx([]), "locality");
    expect(result).toEqual({ byUnit: [], suppressedCount: 0 });
  });
});
