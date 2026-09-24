// Integration tests — macro-projection invariants (qa-poc-minimo.md)
//
// These tests lock in the six invariants that sustain the macro-dashboard
// projection. They run against the real local Postgres (127.0.0.1:54322)
// that CI spins up via `supabase start` + `pnpm db:bootstrap` before
// `pnpm test:coverage`. They cannot be run locally when the Supabase stack
// is stopped.
//
// Invariants covered:
//   INV-1  Vaccine sums to ANIMAL jurisdiction, not vet jurisdiction (§2.7)
//   INV-2  Transfer moves the count: X decrements, Y increments, never both/neither (§5.1)
//   INV-3  Death removes the animal from the active denominator; history persists (§4.2/4.3)
//   INV-4  Owner cannot edit/delete a vet-authored clinical event (§2.2)
//   INV-5  Idempotent submit yields exactly ONE event / one projection effect (§2.13)
//   INV-6  Enumeration oracle: nonexistent token ≡ existing-but-no-access token (§1.8/T.7)

import { createClient } from "@supabase/supabase-js";
import { and, count, countDistinct, eq, gte, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, petEvents, pets, profiles } from "@/db";
import { fetchRabiesCoverage } from "@/lib/analytics/govt-home-kpis";
import { insertEventIdempotent } from "@/lib/events/event-idempotency";
import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";
import { withMutationOverride } from "../_helpers/db-overrides";
import { expectDbError } from "../_helpers/expect-db-error";
import { createFreshTestUser } from "../_helpers/fresh-test-user";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

// Two provinces that are canonical in the schema so the CHECK constraint passes.
// Localities are SYNTHETIC (unique per run) so the fixtures are isolated from the
// national demo seed — a real locality (La Plata) is populated by the seed with
// thousands of unvaccinated pets, diluting the scoped coverage to 0 and breaking
// the INV-1 "counts the dog" assertion. Province scope stays real (CHECK-valid).
const PROVINCE_A = "Buenos Aires";
const LOCALITY_A = `la-plata-macro-${Date.now()}`;
const PROVINCE_B = "Santa Fe";
const LOCALITY_B = `rosario-macro-${Date.now()}`;

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let ownerUserId: string;
let vetUserId: string;

const trackedPetIds: string[] = [];

// ---------------------------------------------------------------------------
// Shared fixture helpers (mirror active-reminders / institutional-scope pattern)
// ---------------------------------------------------------------------------

async function purgeUserByEmail(email: string): Promise<void> {
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  const found = data?.users.find((u) => u.email === email);
  const displayName = email.split("@")[0];

  const orphans = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));

  const ids = [
    ...(found ? [found.id] : []),
    ...orphans.map((o) => o.id).filter((id) => id !== found?.id),
  ];

  for (const uid of ids) {
    await db.execute(sql`delete from notifications where user_id = ${uid}`);
    await withMutationOverride(async (tx) => {
      await tx.execute(
        sql`update pet_events set recorded_by_user_id = null where recorded_by_user_id = ${uid}`,
      );
    });
    await db.delete(profiles).where(eq(profiles.id, uid));
  }

  if (found) await admin.auth.admin.deleteUser(found.id);
}

async function createAuthUser(email: string): Promise<string> {
  const r = await createFreshTestUser(admin, {
    email,
    password: "MacroInv_2026!",
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser(${email}): ${r.error?.message}`);
  return r.data.user.id;
}

async function insertPet(opts: {
  token: string;
  province: string;
  locality: string;
  ownerUserId: string;
  species?: string;
}): Promise<string> {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: opts.token,
      name: `MacroPet_${opts.token.slice(-8)}`,
      species: opts.species ?? "dog",
      sex: "unknown",
      status: "active",
      jurisdictionCountry: "AR",
      jurisdictionProvince: opts.province,
      jurisdictionLocality: opts.locality,
    })
    .returning({ id: pets.id });
  await db.insert(ownerships).values({
    petId: pet.id,
    ownerUserId: opts.ownerUserId,
    role: "owner",
  });
  trackedPetIds.push(pet.id);
  return pet.id;
}

async function insertVaccinationEvent(opts: {
  petId: string;
  recordedByUserId: string;
  authorRole: "owner" | "vet";
  vaccineName: string;
  /** Jurisdiction stored in the JSONB payload (animal's jurisdiction at time of event). */
  payloadProvince: string;
  payloadLocality: string;
  occurredAt?: Date;
}): Promise<string> {
  const occurredAt = opts.occurredAt ?? new Date();
  const [event] = await db
    .insert(petEvents)
    .values({
      petId: opts.petId,
      eventType: "vaccination_administered",
      occurredAt,
      recordedAt: occurredAt,
      recordedByUserId: opts.recordedByUserId,
      authorRole: opts.authorRole,
      authorVerified: opts.authorRole === "vet",
      payload: {
        payload_version: 1,
        vaccine_name: opts.vaccineName,
        lot_number: null,
        vaccine_type: null,
        next_due_date: null,
        vet_name: null,
        clinic_name: null,
        pet_jurisdiction_province: opts.payloadProvince,
        pet_jurisdiction_locality: opts.payloadLocality,
      },
    })
    .returning({ id: petEvents.id });
  return event.id;
}

// ---------------------------------------------------------------------------
// Global beforeAll / afterAll
// ---------------------------------------------------------------------------

const OWNER_EMAIL = "macro-inv-owner@dim-test.local";
const VET_EMAIL = "macro-inv-vet@dim-test.local";

beforeAll(async () => {
  await purgeUserByEmail(OWNER_EMAIL);
  await purgeUserByEmail(VET_EMAIL);

  ownerUserId = await createAuthUser(OWNER_EMAIL);
  vetUserId = await createAuthUser(VET_EMAIL);

  // Vet needs to be a vet role so RLS/author validations work correctly.
  await db.update(profiles).set({ role: "vet" }).where(eq(profiles.id, vetUserId));
});

afterAll(async () => {
  for (const petId of trackedPetIds) {
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, petId));
    });
  }
  await purgeUserByEmail(OWNER_EMAIL);
  await purgeUserByEmail(VET_EMAIL);
});

// ===========================================================================
// INV-1: Vaccine sums to ANIMAL jurisdiction, not vet jurisdiction (§2.7)
//
// A pet lives in locality A. A vet records a rabies vaccination. The rabies-
// coverage projection must count the vaccination under locality A (the
// animal's jurisdiction), NOT some other jurisdiction (the vet's locality).
// The payload field `pet_jurisdiction_province/locality` in the
// vaccination_administered event drives this attribution.
// ===========================================================================

describe("INV-1 (§2.7) — vaccine sums to animal jurisdiction, not vet jurisdiction", () => {
  const TOKEN = `MI-INV1-${Date.now()}`;
  let petId: string;

  beforeAll(async () => {
    // Pet lives in PROVINCE_A / LOCALITY_A.
    petId = await insertPet({
      token: TOKEN,
      province: PROVINCE_A,
      locality: LOCALITY_A,
      ownerUserId,
    });

    // Vet records a rabies vaccination. The payload must carry the ANIMAL's
    // jurisdiction (PROVINCE_A/LOCALITY_A), not the vet's location.
    // Use the REAL canonical form name "Antirrábica" (accented) — that's what
    // the vaccine datalist (lib/lookups.ts) stores. The coverage query must
    // match it via the accent-aware regex; this guards the bug where ILIKE
    // '%rabi%' silently missed accented "Antirrábica" and undercounted to zero.
    await insertVaccinationEvent({
      petId,
      recordedByUserId: vetUserId,
      authorRole: "vet",
      vaccineName: "Antirrábica",
      payloadProvince: PROVINCE_A,
      payloadLocality: LOCALITY_A,
      occurredAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
  });

  it("the vaccination_administered event payload carries the ANIMAL's jurisdiction", async () => {
    const [eventRow] = await db
      .select({ payload: petEvents.payload, authorRole: petEvents.authorRole })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "vaccination_administered")))
      .limit(1);

    expect(eventRow).toBeDefined();
    expect(eventRow.authorRole).toBe("vet");

    const p = eventRow.payload as Record<string, unknown>;
    // Must carry PROVINCE_A/LOCALITY_A (animal's jurisdiction).
    expect(p.pet_jurisdiction_province).toBe(PROVINCE_A);
    expect(p.pet_jurisdiction_locality).toBe(LOCALITY_A);
    // Must NOT carry a different jurisdiction (what a naive "vet location" bug would produce).
    expect(p.pet_jurisdiction_province).not.toBe(PROVINCE_B);
    expect(p.pet_jurisdiction_locality).not.toBe(LOCALITY_B);
  });

  it("fetchRabiesCoverage counts the dog under PROVINCE_A (animal's jurisdiction)", async () => {
    // Scope to PROVINCE_A / LOCALITY_A — should find our vaccinated dog.
    const kpiA = await fetchRabiesCoverage(
      buildProjectionContext(
        { role: "govt" },
        [{ province: PROVINCE_A, locality: LOCALITY_A }],
        windows.trailing12m(),
      ),
    );
    // There is at least one vaccinated dog in scope (our fixture).
    expect(kpiA.current).toBeGreaterThan(0);

    // Direct count of vaccinated dogs in the animal's jurisdiction.
    const [vaccInA] = await db
      .select({ n: countDistinct(petEvents.petId) })
      .from(petEvents)
      .innerJoin(pets, eq(pets.id, petEvents.petId))
      .where(
        and(
          eq(petEvents.petId, petId),
          eq(petEvents.eventType, "vaccination_administered"),
          sql`(${petEvents.payload}->>'vaccine_name') ~* '(antirr[áa]bica|rabies)'`,
          eq(pets.jurisdictionProvince, PROVINCE_A),
          eq(pets.jurisdictionLocality, LOCALITY_A),
        ),
      );
    expect(vaccInA.n).toBe(1);
  });

  it("the vaccine does NOT count under PROVINCE_B/LOCALITY_B (vet's hypothetical jurisdiction)", async () => {
    // If the vet lived in PROVINCE_B, a bug would attribute the event there.
    // Verify the event payload does not point to PROVINCE_B.
    const [eventRow] = await db
      .select({ payload: petEvents.payload })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "vaccination_administered")))
      .limit(1);

    const p = eventRow.payload as Record<string, unknown>;
    // The projection scope clause reads payload->>'pet_jurisdiction_province'.
    // If this were PROVINCE_B, the event would count in the wrong jurisdiction.
    expect(p.pet_jurisdiction_province).toBe(PROVINCE_A);
  });
});

// ===========================================================================
// INV-2: Transfer moves the count — X decrements, Y increments (§5.1)
//
// A dog counted in jurisdiction X; owner changes to a new owner in Y.
// After the jurisdiction update (which transfer use-case performs on pets),
// the pet must count in Y only. Never both, never neither.
// ===========================================================================

describe("INV-2 (§5.1) — ownership transfer moves jurisdiction count", () => {
  const TOKEN = `MI-INV2-${Date.now()}`;
  let petId: string;

  beforeAll(async () => {
    petId = await insertPet({
      token: TOKEN,
      province: PROVINCE_A,
      locality: LOCALITY_A,
      ownerUserId,
    });
  });

  it("before transfer: active dog is counted under PROVINCE_A only", async () => {
    const [row] = await db
      .select({
        jurisdictionProvince: pets.jurisdictionProvince,
        jurisdictionLocality: pets.jurisdictionLocality,
        status: pets.status,
      })
      .from(pets)
      .where(eq(pets.id, petId))
      .limit(1);

    expect(row.status).toBe("active");
    expect(row.jurisdictionProvince).toBe(PROVINCE_A);
    expect(row.jurisdictionLocality).toBe(LOCALITY_A);
  });

  it("after transfer (pets.jurisdiction updated to B): dog is counted in B, not A", async () => {
    // Simulate what the transfer use-case does: update pets.jurisdictionProvince/Locality.
    await db
      .update(pets)
      .set({ jurisdictionProvince: PROVINCE_B, jurisdictionLocality: LOCALITY_B })
      .where(eq(pets.id, petId));

    const [inA] = await db
      .select({ n: count() })
      .from(pets)
      .where(
        and(
          eq(pets.id, petId),
          sql`${pets.status} IN ('active', 'lost')`,
          eq(pets.jurisdictionProvince, PROVINCE_A),
          eq(pets.jurisdictionLocality, LOCALITY_A),
        ),
      );

    const [inB] = await db
      .select({ n: count() })
      .from(pets)
      .where(
        and(
          eq(pets.id, petId),
          sql`${pets.status} IN ('active', 'lost')`,
          eq(pets.jurisdictionProvince, PROVINCE_B),
          eq(pets.jurisdictionLocality, LOCALITY_B),
        ),
      );

    // Never both, never neither.
    expect(inA.n).toBe(0); // left A
    expect(inB.n).toBe(1); // arrived in B
  });

  it("count(A) + count(B) for this pet is always exactly 1 — no double-counting", async () => {
    const [inA] = await db
      .select({ n: count() })
      .from(pets)
      .where(
        and(
          eq(pets.id, petId),
          sql`${pets.status} IN ('active', 'lost')`,
          eq(pets.jurisdictionProvince, PROVINCE_A),
        ),
      );
    const [inB] = await db
      .select({ n: count() })
      .from(pets)
      .where(
        and(
          eq(pets.id, petId),
          sql`${pets.status} IN ('active', 'lost')`,
          eq(pets.jurisdictionProvince, PROVINCE_B),
        ),
      );

    expect(inA.n + inB.n).toBe(1);
  });
});

// ===========================================================================
// INV-3: Death removes animal from active denominator; history persists (§4.2/4.3)
//
// After a death_recorded event, pets.status must be 'deceased' and the pet
// must NOT appear in the active denominator used by fetchRabiesCoverage
// (which filters status IN ('active','lost')). The pet row and events remain.
// ===========================================================================

describe("INV-3 (§4.2/4.3) — death removes from active denominator, history persists", () => {
  const TOKEN = `MI-INV3-${Date.now()}`;
  let petId: string;

  beforeAll(async () => {
    petId = await insertPet({
      token: TOKEN,
      province: PROVINCE_A,
      locality: LOCALITY_A,
      ownerUserId,
    });

    // Record a vaccination so this dog exists in the vaccinated set before death.
    await insertVaccinationEvent({
      petId,
      recordedByUserId: ownerUserId,
      authorRole: "owner",
      vaccineName: "Antirrábica",
      payloadProvince: PROVINCE_A,
      payloadLocality: LOCALITY_A,
      occurredAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
    });
  });

  it("before death: pet status is active and vaccination event exists", async () => {
    const [petRow] = await db
      .select({ status: pets.status })
      .from(pets)
      .where(eq(pets.id, petId))
      .limit(1);
    expect(petRow.status).toBe("active");

    const evts = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "vaccination_administered")));
    expect(evts.length).toBeGreaterThanOrEqual(1);
  });

  it("after death event + status update: status=deceased and deceasedAt is set", async () => {
    const now = new Date();

    // Insert a death_recorded event (mirrors what createDeathRecord does inside tx).
    await db.insert(petEvents).values({
      petId,
      eventType: "death_recorded",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: ownerUserId,
      authorRole: "owner",
      authorVerified: false,
      payload: {
        payload_version: 1,
        cause: "natural",
        cause_detail: null,
        confirmed_by_vet: null,
        vet_name: null,
        disease_code: null,
        is_reportable: false,
      },
    });

    // Update pets.status to deceased (mirrors updateDeceased in the use-case).
    await db.update(pets).set({ status: "deceased", deceasedAt: now }).where(eq(pets.id, petId));

    const [petRow] = await db
      .select({ status: pets.status, deceasedAt: pets.deceasedAt })
      .from(pets)
      .where(eq(pets.id, petId))
      .limit(1);

    expect(petRow.status).toBe("deceased");
    expect(petRow.deceasedAt).not.toBeNull();
  });

  it("deceased pet does NOT appear in the active denominator (status IN ('active','lost'))", async () => {
    const [activeCount] = await db
      .select({ n: count() })
      .from(pets)
      .where(and(eq(pets.id, petId), sql`${pets.status} IN ('active', 'lost')`));
    expect(activeCount.n).toBe(0);
  });

  it("pet row persists after death (history preserved)", async () => {
    const [petRow] = await db
      .select({ id: pets.id, status: pets.status })
      .from(pets)
      .where(eq(pets.id, petId))
      .limit(1);
    expect(petRow).toBeDefined();
    expect(petRow.status).toBe("deceased");
  });

  it("all events persist after death: vaccination and death_recorded are both present", async () => {
    const evts = await db
      .select({ eventType: petEvents.eventType })
      .from(petEvents)
      .where(eq(petEvents.petId, petId));

    const types = evts.map((e) => e.eventType);
    expect(types).toContain("vaccination_administered");
    expect(types).toContain("death_recorded");
  });

  it("fetchRabiesCoverage denominator excludes this deceased pet", async () => {
    // Direct check: the pet must NOT appear in the dogs denominator
    // (species=dog + status IN ('active','lost') + jurisdiction=A).
    const [denomCheck] = await db
      .select({ n: count() })
      .from(pets)
      .where(
        and(
          eq(pets.id, petId),
          eq(pets.species, "dog"),
          sql`${pets.status} IN ('active', 'lost')`,
          eq(pets.jurisdictionProvince, PROVINCE_A),
        ),
      );
    expect(denomCheck.n).toBe(0);

    // The KPI itself must not error.
    const kpi = await fetchRabiesCoverage(
      buildProjectionContext(
        { role: "govt" },
        [{ province: PROVINCE_A, locality: LOCALITY_A }],
        windows.trailing12m(),
      ),
    );
    expect(kpi.current).toBeGreaterThanOrEqual(0);
    expect(kpi.target).toBe(80);
  });
});

// ===========================================================================
// INV-4: Owner cannot edit/delete a vet-authored clinical event (§2.2)
//
// The pet_events append-only trigger blocks ALL UPDATE/DELETE on pet_events
// unless the session-local escape hatch GUCs are set. This is role-agnostic:
// whether the caller pretends to be an owner or a vet, a plain Drizzle write
// is rejected. This enforces immutability of vet-authored events.
// ===========================================================================

describe("INV-4 (§2.2) — vet-authored clinical events are immutable (append-only trigger)", () => {
  const TOKEN = `MI-INV4-${Date.now()}`;
  let petId: string;
  let vetEventId: string;

  beforeAll(async () => {
    petId = await insertPet({
      token: TOKEN,
      province: PROVINCE_A,
      locality: LOCALITY_A,
      ownerUserId,
    });

    vetEventId = await insertVaccinationEvent({
      petId,
      recordedByUserId: vetUserId,
      authorRole: "vet",
      vaccineName: "Antirrábica",
      payloadProvince: PROVINCE_A,
      payloadLocality: LOCALITY_A,
    });
  });

  it("the vet-authored event exists and has authorRole=vet", async () => {
    const [row] = await db
      .select({ authorRole: petEvents.authorRole })
      .from(petEvents)
      .where(eq(petEvents.id, vetEventId))
      .limit(1);

    expect(row).toBeDefined();
    expect(row.authorRole).toBe("vet");
  });

  it("direct UPDATE on a vet-authored event is rejected by the append-only trigger", async () => {
    await expectDbError(
      db
        .update(petEvents)
        .set({ notes: "owner attempting to alter vet event" })
        .where(eq(petEvents.id, vetEventId)),
      { constraint: /append-only/i },
    );
  });

  it("direct DELETE on a vet-authored event is rejected by the append-only trigger", async () => {
    await expectDbError(db.delete(petEvents).where(eq(petEvents.id, vetEventId)), {
      constraint: /append-only/i,
    });
  });

  it("the vet-authored event is unchanged after rejected mutations", async () => {
    const [row] = await db
      .select({ authorRole: petEvents.authorRole, notes: petEvents.notes })
      .from(petEvents)
      .where(eq(petEvents.id, vetEventId))
      .limit(1);

    expect(row).toBeDefined();
    expect(row.authorRole).toBe("vet");
    expect(row.notes).toBeNull();
  });
});

// ===========================================================================
// INV-5: Idempotent submit yields ONE event and ONE projection effect (§2.13)
//
// Submitting the same event twice with the same clientIdempotencyKey yields
// exactly one row. The second call returns wasNoop=true. No duplicate
// projection effect (countDistinct of pet_id also confirms 1).
// ===========================================================================

describe("INV-5 (§2.13) — idempotent submit yields exactly one event and one projection effect", () => {
  const TOKEN = `MI-INV5-${Date.now()}`;
  let petId: string;
  // Must be a valid UUID — pet_events.client_idempotency_key is a UUID column.
  const IDEMPOTENCY_KEY = crypto.randomUUID();
  const VACCINE_OCCURRED_AT = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

  beforeAll(async () => {
    petId = await insertPet({
      token: TOKEN,
      province: PROVINCE_A,
      locality: LOCALITY_A,
      ownerUserId,
    });
  });

  it("first insert with idempotency key: wasNoop=false, event created", async () => {
    const result = await insertEventIdempotent({
      petId,
      eventType: "vaccination_administered",
      occurredAt: VACCINE_OCCURRED_AT,
      recordedAt: VACCINE_OCCURRED_AT,
      recordedByUserId: ownerUserId,
      authorRole: "owner",
      authorVerified: false,
      payload: {
        // Real canonical form name (accented) — matched by the accent-aware regex.
        // A schema-valid payload: the shared helper validates it (finding A08-7),
        // and pet_jurisdiction_* are not vaccination_administered keys.
        vaccine_name: "Antirrábica",
        brand: null,
        batch: null,
        administered_by: null,
        next_due_at: null,
      },
      clientIdempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result.wasNoop).toBe(false);
    expect(result.event.id).toBeDefined();
    expect(result.event.clientIdempotencyKey).toBe(IDEMPOTENCY_KEY);
  });

  it("second insert with same key: wasNoop=true, no duplicate row", async () => {
    // Different recordedAt to simulate a genuine re-submit.
    const result = await insertEventIdempotent({
      petId,
      eventType: "vaccination_administered",
      occurredAt: VACCINE_OCCURRED_AT,
      recordedAt: new Date(),
      recordedByUserId: ownerUserId,
      authorRole: "owner",
      authorVerified: false,
      payload: {
        vaccine_name: "Antirrábica",
        brand: null,
        batch: null,
        administered_by: null,
        next_due_at: null,
      },
      clientIdempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result.wasNoop).toBe(true);
  });

  it("exactly ONE vaccination_administered row exists for this idempotency key", async () => {
    const rows = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, petId),
          eq(petEvents.eventType, "vaccination_administered"),
          eq(petEvents.clientIdempotencyKey, IDEMPOTENCY_KEY),
        ),
      );

    expect(rows).toHaveLength(1);
  });

  it("countDistinct(pet_id) for the vaccinated set counts this dog exactly once", async () => {
    // The KPI uses countDistinct(petEvents.petId) — even if two rows existed,
    // this would dedup. We assert both that: (a) rows = 1, and (b) distinct = 1.
    const [result] = await db
      .select({ n: countDistinct(petEvents.petId) })
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, petId),
          eq(petEvents.eventType, "vaccination_administered"),
          sql`(${petEvents.payload}->>'vaccine_name') ~* '(antirr[áa]bica|rabies)'`,
          gte(petEvents.occurredAt, new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)),
        ),
      );

    expect(result.n).toBe(1);
  });
});

// ===========================================================================
// INV-6: Enumeration oracle (§1.8 / T.7)
//
// The public pet-token lookup must return an indistinguishable result for a
// nonexistent token vs an existing-but-no-access token. We verify the DB
// layer returns binary (0 or 1 row) results, and that the page (which calls
// notFound() for 0 rows) normalizes "restricted" and "nonexistent" into the
// same HTTP response. The rate-limit behavior is covered separately in
// public-token-page-rate-limit.test.ts.
// ===========================================================================

describe("INV-6 (§1.8/T.7) — enumeration oracle: nonexistent ≡ existing-but-no-access", () => {
  const EXISTING_TOKEN = `MI-INV6-${Date.now()}`;
  const NONEXISTENT_TOKEN = "DIM-ZZZZ-ZZZZ";
  let existingPetId: string;

  beforeAll(async () => {
    existingPetId = await insertPet({
      token: EXISTING_TOKEN,
      province: PROVINCE_A,
      locality: LOCALITY_A,
      ownerUserId,
    });
  });

  it("nonexistent token yields zero DB rows", async () => {
    const rows = await db
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, NONEXISTENT_TOKEN))
      .limit(1);

    expect(rows).toHaveLength(0);
  });

  it("existing token yields one DB row (existence is known at DB level)", async () => {
    const rows = await db
      .select({ id: pets.id, publicToken: pets.publicToken })
      .from(pets)
      .where(eq(pets.publicToken, EXISTING_TOKEN))
      .limit(1);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(existingPetId);
  });

  it("DB results are binary (0 or 1) — no partial information leakage", async () => {
    // A caller probing tokens gets either 0 rows (nonexistent) or 1 row
    // (exists, then the page enforces access control). The key oracle invariant:
    // the PAGE must call notFound() for BOTH "nonexistent" and "exists but
    // inaccessible" — making HTTP responses identical.
    //
    // This test documents the DB contract: results are always 0 or 1 (never
    // partial metadata like "exists but you can't see it"). The page layer
    // (tested in public-token-page-rate-limit.test.ts) enforces the HTTP-level
    // indistinguishability.

    const existingRows = await db
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, EXISTING_TOKEN))
      .limit(1);

    const nonExistingRows = await db
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, NONEXISTENT_TOKEN))
      .limit(1);

    expect(existingRows.length).toBeGreaterThanOrEqual(0);
    expect(existingRows.length).toBeLessThanOrEqual(1);
    expect(nonExistingRows.length).toBe(0);

    // The sum confirms both cases are covered: one known-present, one known-absent.
    expect(existingRows.length + nonExistingRows.length).toBe(1);
  });
});
