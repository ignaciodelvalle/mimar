// Integration test for the registered-adopter finalization contract
// (org-pilot-pack, spec Req 2 read through the reconciliation ruling):
//
//   match = profiles row with matching dniHash AND an auth.users row EXISTS.
//   dniVerified is NOT required. Legacy stubs (no auth row) REFUSE.
//
// This runs against the real local Postgres (Supabase stack on 54321/54322)
// because the entire value of findAdopterAccountByDni is the raw-SQL EXISTS
// against auth.users — a mocked repo cannot validate that join. Pattern
// mirrors __tests__/adoption-cascade.test.ts (admin client + session mock +
// withMutationOverride cleanup).
//
// Cases:
//   1. checkAdopterAccountAction — capability gate + found/not-found surface.
//   2. Legacy stub (profiles row, NO auth.users row) → finalize refuses,
//      no new profiles row, no adoption_finalized event.
//   3. No profiles row at all → finalize refuses, nothing inserted.
//   4. Registered account with dniVerified=false → finalize PROCEEDS onto the
//      real userId (the reconciliation's core claim).

import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { and, count, eq, isNull, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { dniLast4, hashDni } from "@/lib/utils/dni-hash";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import {
  auditLog,
  db,
  notifications,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
  rateLimitBuckets,
} from "@/db";
import { createClient } from "@/lib/supabase/server";
import { checkAdopterAccountAction, finalizeAdoptionAction } from "@/src/modules/adoption/actions";
import { ADOPTER_DNI_CHECK_LIMITS } from "@/src/modules/adoption/domain/dni-check-policy";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const ADOPTER_EMAIL = "adopt-regreq-adopter@dim-test.local";
const COORD_EMAIL = "adopt-regreq-coord@dim-test.local";
const PASS = "RegReq_2026!";

const ORG_TOKEN = "DIM-REGADOPT-01";
const PET_TOKEN = "DIM-REGA-PET1";

// Three DNIs, three fates:
const REGISTERED_DNI = "50000001"; // auth.users + profiles, dniVerified=FALSE
const STUB_DNI = "50000002"; // profiles only (legacy stub), no auth row
const ABSENT_DNI = "50000003"; // no profiles row at all

let adopterUserId: string;
let coordUserId: string;
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
    // Stale stub / registered profiles from a crashed run (hash-addressed).
    for (const dni of [STUB_DNI]) {
      await tx.delete(profiles).where(eq(profiles.dniHash, hashDni(dni)));
    }
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

/** Count profiles rows whose dniHash matches the given DNI. */
async function profilesCountForDni(dni: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(profiles)
    .where(eq(profiles.dniHash, hashDni(dni)));
  return row?.n ?? 0;
}

async function finalizedEventCount(): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "adoption_finalized")));
  return row?.n ?? 0;
}

function finalizeFormData(dni: string): FormData {
  const fd = new FormData();
  fd.set("adopterDni", dni);
  fd.set("adopterDisplayName", "Persona Adoptante");
  fd.set("adopterPhone", "+541122334455");
  fd.set("followupMonths", "0");
  fd.set("notes", "Registered-adopter contract test");
  return fd;
}

beforeAll(async () => {
  await purgeStaleFixtures();
  for (const email of [ADOPTER_EMAIL, COORD_EMAIL]) {
    await purgeUserByEmail(email);
  }

  // Registered adopter: REAL auth.users row + profiles row, dniVerified=FALSE
  // on purpose — the reconciliation says a fresh on-the-spot signup matches.
  const adopterRes = await createFreshTestUser(supabaseAdmin, {
    email: ADOPTER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (adopterRes.error || !adopterRes.data.user) {
    throw new Error(`createUser adopter: ${adopterRes.error?.message}`);
  }
  adopterUserId = adopterRes.data.user.id;
  await db
    .update(profiles)
    .set({
      displayName: "Registrada Reciente",
      phone: "+541100000001",
      dniHash: hashDni(REGISTERED_DNI),
      dniLast4: dniLast4(REGISTERED_DNI),
      dniVerified: false,
      role: "owner",
      accountType: "personal",
    })
    .where(eq(profiles.id, adopterUserId));

  const coordRes = await createFreshTestUser(supabaseAdmin, {
    email: COORD_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (coordRes.error || !coordRes.data.user) {
    throw new Error(`createUser coord: ${coordRes.error?.message}`);
  }
  coordUserId = coordRes.data.user.id;
  await db
    .update(profiles)
    .set({ displayName: "RegReq Coord", role: "owner", accountType: "personal" })
    .where(eq(profiles.id, coordUserId));

  // Legacy stub: profiles row with a matching hash, NO auth.users row — the
  // exact artifact the retired manual-DNI branch used to create.
  stubProfileId = randomUUID();
  await db.insert(profiles).values({
    id: stubProfileId,
    displayName: "Stub Legado",
    dniHash: hashDni(STUB_DNI),
    dniLast4: dniLast4(STUB_DNI),
    dniVerified: false,
    role: "owner",
  });

  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN,
      legalName: "RegReq Test Refugio SRL",
      displayName: "RegReq Refugio",
      orgType: "shelter",
      email: "regreq@dim-test.local",
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
      name: "Regina",
      species: "dog",
      sex: "female",
      potentiallyDangerousBreed: false,
      adoptionEligible: true,
      adoptionEligibilitySetAt: now,
      inCustodyDispute: false,
      rabiesObservationStatus: null,
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
  for (const email of [ADOPTER_EMAIL, COORD_EMAIL]) {
    await purgeUserByEmail(email);
  }
});

describe("registered-adopter finalization contract (auth.users EXISTS gate)", () => {
  it("checkAdopterAccountAction enforces the adoption.finalize capability", async () => {
    // The adopter has no membership in the org — the gate must reject.
    mockSessionAs(adopterUserId);
    const r = await checkAdopterAccountAction(ORG_TOKEN, REGISTERED_DNI);
    expect("error" in r && typeof r.error === "string").toBe(true);
  });

  it("checkAdopterAccountAction: registered (dniVerified=false) → found; stub and absent → not found", async () => {
    mockSessionAs(coordUserId);

    const registered = await checkAdopterAccountAction(ORG_TOKEN, REGISTERED_DNI);
    expect(registered).toEqual({ found: true, displayName: "Registrada Reciente" });

    const stub = await checkAdopterAccountAction(ORG_TOKEN, STUB_DNI);
    expect(stub).toEqual({ found: false });

    const absent = await checkAdopterAccountAction(ORG_TOKEN, ABSENT_DNI);
    expect(absent).toEqual({ found: false });
  });

  // -------------------------------------------------------------------------
  // D4 (PO 2026-08-23): trail + ceiling on the DNI confirmation oracle.
  //
  // checkAdopterAccountAction lets any holder of `adoption.finalize` type a DNI
  // and learn whether that person has a miMAR account and their display name.
  // It is a READ, so lint:audit-log (which derives MUTATING actions) is
  // structurally blind to it — batch A exempted it for exactly that reason and
  // said so in the exemption comment. The PO's answer is not to remove the
  // feature: confirming an adopter at the counter is the legitimate use and
  // must stay unhindered. It is to make the consultation leave a trace and to
  // put a ceiling on it that a front desk never touches and a sweep does.
  // -------------------------------------------------------------------------

  it("D4: every consultation leaves a pii_queried trail keyed on the HASHED dni", async () => {
    mockSessionAs(coordUserId);
    // audit_log is append-only (enforce_audit_log_append_only) — a DELETE is
    // blocked by the database, which is exactly the property that makes it a
    // trail. So the test measures a DELTA instead of clearing.
    const rowsFor = async () =>
      db
        .select({ payload: auditLog.payload })
        .from(auditLog)
        .where(and(eq(auditLog.actorUserId, coordUserId), eq(auditLog.action, "pii_queried")));

    const before = await rowsFor();

    const found = await checkAdopterAccountAction(ORG_TOKEN, REGISTERED_DNI);
    expect(found).toEqual({ found: true, displayName: "Registrada Reciente" });
    // A NOT-found answer is the oracle's most interesting output — it must be
    // traced too, not only the hits.
    await checkAdopterAccountAction(ORG_TOKEN, ABSENT_DNI);

    const after = await rowsFor();
    expect(after.length - before.length).toBe(2);

    const payloads = after.map((r) => r.payload as Record<string, unknown>);
    for (const p of payloads) {
      expect(p.surface).toBe("adopter_dni_check");
      // Who asked, at organization grain — the ceiling is per-org, so the trail
      // has to name the org too, not only the person.
      expect(p.organization_id).toBe(orgId);
    }
    // Which DNI — hashed. Invariant 5: never plaintext, anywhere.
    const queries = payloads.map((p) => p.query);
    expect(queries).toContain(hashDni(REGISTERED_DNI));
    expect(queries).toContain(hashDni(ABSENT_DNI));
    expect(JSON.stringify(payloads)).not.toContain(REGISTERED_DNI);
    expect(JSON.stringify(payloads)).not.toContain(ABSENT_DNI);
  });

  // The clock is FROZEN for this test, and the freeze is the test, not a
  // convenience. `enforceRateLimit` is a FIXED-window limiter: the bucket key
  // embeds `Math.floor(Date.now() / 60_000) * 60_000` (lib/infra/rate-limit.ts).
  // Nine sequential consultations, each of them several round trips to Postgres
  // plus an awaited audit_log insert, take long enough under full-suite load to
  // straddle a wall-clock minute boundary. When they do, the later calls land on
  // a NEW key, the counter never reaches eight, and the ninth is ALLOWED — the
  // assertion below then fails on code that is completely correct.
  //
  // Not hypothetical: this file went red exactly that way on 2026-09-10 under a
  // 1218-second full-suite run, having passed for weeks in isolation. The other
  // explanation was ruled out first — `checkAdopterAccountAction` calls the
  // limiter unconditionally once auth and the DNI shape pass, and all eight loop
  // calls returned without error, so all eight incremented. A different key is
  // the only way the ninth survives.
  //
  // Three sibling suites already carry this guard for the same reason and the
  // same limiter (localities-search-action, tag-actions-rate-limit,
  // scan-log-rate-limit, all since 2026-08-08); this file had missed it. The
  // `:30` mid-minute timestamp is theirs too — half a minute of headroom on
  // either side means no arrangement of the calls can cross a boundary.
  //
  // ONLY Date is faked. This suite drives the real limiter through postgres.js,
  // which needs live setTimeout/setInterval for its connection timeouts, so
  // faking the timer family would hang the driver rather than steady the clock.
  //
  // AND THE INSTANT IS DERIVED FROM THE REAL CLOCK, NOT HARDCODED. A literal
  // calendar date would be in the PAST from the day after it was written, and
  // `enforceRateLimit` writes `expires_at` from whatever clock it reads
  // (lib/infra/rate-limit.ts). A bucket stamped as already-expired is fair game
  // for `cleanupExpiredBuckets`, which __tests__/cron-data-lifecycle.test.ts
  // drains in a loop — `DELETE FROM rate_limit_buckets WHERE expires_at < now()`
  // — against this same local database, from a parallel worker. Land that drain
  // between two of the nine consultations below and the counter is wiped, the
  // ninth is allowed, and this test fails on correct code: the very failure it
  // was written to remove, re-entering through a different door.
  it("D4: the N+1-th consultation from one organization is refused", async () => {
    mockSessionAs(coordUserId);
    const midMinute = Math.floor(Date.now() / 60_000) * 60_000 + 30_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(midMinute));
    try {
      // Start from a clean minute bucket — earlier tests in this file consulted
      // under the same org.
      await db
        .delete(rateLimitBuckets)
        .where(like(rateLimitBuckets.bucketKey, "adopter_dni_check:%"));

      for (let i = 0; i < ADOPTER_DNI_CHECK_LIMITS.maxPerMinute; i++) {
        const r = await checkAdopterAccountAction(ORG_TOKEN, ABSENT_DNI);
        expect("error" in r).toBe(false);
      }

      const overTheLine = await checkAdopterAccountAction(ORG_TOKEN, ABSENT_DNI);
      expect("error" in overTheLine).toBe(true);
      expect((overTheLine as { error: string }).error).toMatch(/consultas/i);

      await db
        .delete(rateLimitBuckets)
        .where(like(rateLimitBuckets.bucketKey, "adopter_dni_check:%"));
    } finally {
      // Restore in a finally: a failed assertion above must not leave a frozen
      // clock behind for the tests that follow in this file.
      vi.useRealTimers();
    }
  });

  it("legacy stub (profiles row, NO auth.users row) → finalize REFUSES with no writes", async () => {
    mockSessionAs(coordUserId);
    const profilesBefore = await profilesCountForDni(STUB_DNI);
    expect(profilesBefore).toBe(1); // the seeded stub

    const result = await finalizeAdoptionAction(
      ORG_TOKEN,
      PET_TOKEN,
      { error: null },
      finalizeFormData(STUB_DNI),
    );

    expect(result.error).toMatch(/cuenta miMAR/i);
    expect(result.redirectTo).toBeUndefined();
    // No stub-creation, no event, custody untouched (spec 2.3).
    expect(await profilesCountForDni(STUB_DNI)).toBe(profilesBefore);
    expect(await finalizedEventCount()).toBe(0);
    const [custody] = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      );
    expect(custody).toBeDefined();
  });

  it("no profiles row at all → finalize REFUSES and inserts nothing", async () => {
    mockSessionAs(coordUserId);
    expect(await profilesCountForDni(ABSENT_DNI)).toBe(0);

    const result = await finalizeAdoptionAction(
      ORG_TOKEN,
      PET_TOKEN,
      { error: null },
      finalizeFormData(ABSENT_DNI),
    );

    expect(result.error).toMatch(/cuenta miMAR/i);
    // The old branch would have inserted a randomUUID() stub here. Never again.
    expect(await profilesCountForDni(ABSENT_DNI)).toBe(0);
    expect(await finalizedEventCount()).toBe(0);
  });

  it("registered account with dniVerified=false → finalize PROCEEDS onto the real userId", async () => {
    mockSessionAs(coordUserId);
    const profilesBefore = await profilesCountForDni(REGISTERED_DNI);
    expect(profilesBefore).toBe(1);

    const result = await finalizeAdoptionAction(
      ORG_TOKEN,
      PET_TOKEN,
      { error: null },
      finalizeFormData(REGISTERED_DNI),
    );

    expect(result.error).toBeNull();
    expect(result.redirectTo).toContain(`/org/${ORG_TOKEN}/mascotas?adopcion=`);

    // Exactly one adoption_finalized event, adopter = the REAL account.
    const finalized = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "adoption_finalized")));
    expect(finalized).toHaveLength(1);
    expect((finalized[0].payload as { adopter_user_id: string }).adopter_user_id).toBe(
      adopterUserId,
    );

    // Ownership landed on the registered account (role=owner, active).
    const [ownerRow] = await db
      .select({ ownerUserId: ownerships.ownerUserId })
      .from(ownerships)
      .where(
        and(eq(ownerships.petId, petId), eq(ownerships.role, "owner"), isNull(ownerships.endedAt)),
      );
    expect(ownerRow?.ownerUserId).toBe(adopterUserId);

    // No extra profiles row appeared for this DNI (no stub side-channel).
    expect(await profilesCountForDni(REGISTERED_DNI)).toBe(profilesBefore);
  });
});
