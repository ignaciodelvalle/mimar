// Integration tests for lib/compliance-metrics (Item 4 — compliance & enforcement).
//
// Covers the six shippable metrics from
// docs/superpowers/specs/2026-06-18-compliance-enforcement-metrics-design.md:
//   C1 microchip penetration, C2 ISO-validity, C5 chip-fraud signal,
//   C7 dangerous-breed registry compliance (graceful 0%),
//   D4 reunification rate, D5 seizures (decomisos).
//
// All fetchers are jurisdiction-scoped + period-aware projections over the
// existing event log (Pattern B). Tests seed into UNIQUE test jurisdictions so
// counts are deterministic on the shared dev DB, and assert via a GOVT-scoped
// ProjectionContext (the scope filter isolates our fixtures). Includes a
// k-anonymity suppression case (C1 locality breakdown) and jurisdiction-scope
// cases (C1 + D5).

import { createClient } from "@supabase/supabase-js";
import { inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, petEvents, petIdentifications, pets, profiles } from "@/db";
import {
  fetchChipReplacementSignal,
  fetchDangerousBreedCompliance,
  fetchIsoValidity,
  fetchMicrochipPenetration,
  fetchMicrochipPenetrationByProvince,
  fetchPppComplianceByProvince,
  fetchReunificationRate,
  fetchSeizures,
} from "@/lib/analytics/compliance-metrics";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

// Test jurisdiction — the province MUST be one of the 24 canonical names
// (DB check constraint pets_jurisdiction_province_canonical). We use a real
// low-traffic province plus UNIQUE locality names that no other fixture uses,
// so govt-scoped counts (which match the exact province+locality pair) stay
// deterministic on the shared dev DB.
const PROV = "La Pampa";
const LOC_A = "CE-LOC-A-uniq";
const LOC_B = "CE-LOC-B-uniq";
const TOKEN_PREFIX = "CE-TEST-";
const OWNER_EMAIL = "compliance-metrics-owner@dim-test.local";

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
    password: "ComplianceMetricsTest_2026!",
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
  await db.delete(petIdentifications).where(inArray(petIdentifications.petId, ids));
  // pet_events has a BEFORE DELETE trigger; the GUC override is the escape hatch.
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(inArray(petEvents.petId, ids));
  });
  await db.delete(ownerships).where(inArray(ownerships.petId, ids));
  await db.delete(pets).where(inArray(pets.id, ids));
}

async function insertPet(input: {
  province: string;
  locality: string;
  status?: "active" | "lost" | "deceased";
  ppp?: boolean;
}): Promise<string> {
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: `${TOKEN_PREFIX}${generatePublicToken().slice(4)}`,
      name: "CETestPet",
      species: "dog",
      jurisdictionProvince: input.province,
      jurisdictionLocality: input.locality,
      status: input.status ?? "active",
      potentiallyDangerousBreed: input.ppp ?? false,
    })
    .returning({ id: pets.id });
  await db.insert(ownerships).values({ petId: row.id, ownerUserId, role: "owner" });
  return row.id;
}

// Sequence counter so each chip code is a UNIQUE 15-digit numeric string
// (the chip_requires_iso_fields constraint mandates length(code)=15 for
// microchip_iso; the chip_unique partial index forbids duplicate active codes).
let chipSeq = 0;
function nextChipCode(): string {
  chipSeq += 1;
  return String(900_000_000_000_000 + chipSeq); // 15 digits, collision-free per run
}

// Insert an active microchip_iso identification row. When `iso` is true the
// decomposed ISO fields are well-formed (C2 "valid"); when false the row is a
// legacy/non-ISO chip — chipped but with NULL decomposition (C2 "invalid"),
// exactly how migration 0083 stores non-ISO chips (iso_compliant=false).
async function insertChip(
  petId: string,
  opts: { iso?: boolean; country?: string; manufacturer?: string; national?: string } = {},
) {
  await db.insert(petIdentifications).values({
    petId,
    kind: "microchip_iso",
    status: "active",
    code: nextChipCode(),
    recordedAt: new Date().toISOString().slice(0, 10),
    isoCompliant: opts.iso ?? false,
    isoCountryCode: opts.iso ? (opts.country ?? "032") : null, // 032 = Argentina
    isoManufacturerCode: opts.iso ? (opts.manufacturer ?? "0999") : null,
    isoNationalId: opts.iso ? (opts.national ?? "00012345") : null,
  });
}

async function emitEvent(
  petId: string,
  eventType: string,
  payload: Record<string, unknown>,
  occurredAt = new Date(),
) {
  await db.insert(petEvents).values({
    petId,
    eventType,
    occurredAt,
    payload: { payload_version: 1, ...payload },
    authorRole: "system",
    recordedByUserId: null,
  });
}

beforeAll(async () => {
  ownerUserId = await ensureOwner();
  await cleanupFixtures();
});

// Each test seeds its own fixtures into the shared dev DB; clean up after every
// test so per-metric counts stay isolated (mirrors govt-dashboards.test.ts).
afterEach(cleanupFixtures);
afterAll(cleanupFixtures);

// ---------------------------------------------------------------------------
// C1 — Microchip penetration
// ---------------------------------------------------------------------------

describe("fetchMicrochipPenetration (C1)", () => {
  it("computes chipped/active ratio and excludes pets outside jurisdiction", async () => {
    // In scope (LOC_A): 2 active pets, 1 chipped.
    const a1 = await insertPet({ province: PROV, locality: LOC_A });
    await insertPet({ province: PROV, locality: LOC_A });
    await insertChip(a1, { iso: true });
    // Out of scope (Buenos Aires): an active chipped pet that must NOT count.
    const out = await insertPet({ province: "Buenos Aires", locality: "La Plata" });
    await insertChip(out, { iso: true });

    const r = await fetchMicrochipPenetration(govtCtx([{ province: PROV, locality: LOC_A }]));
    expect(r.active).toBe(2);
    expect(r.chipped).toBe(1);
    expect(r.ratePct).toBe(50);
  });

  it("returns zero shape for govt with no jurisdictions without hitting DB", async () => {
    const r = await fetchMicrochipPenetration(govtCtx([]));
    expect(r).toEqual({ ratePct: 0, chipped: 0, active: 0, byLocality: r.byLocality });
    expect(r.byLocality.suppressedCount).toBe(0);
  });

  it("suppresses locality cells below k=5 (k-anonymity)", async () => {
    // LOC_A: 6 active pets (>= k) → visible. LOC_B: 2 active pets (< k) → suppressed.
    for (let i = 0; i < 6; i++) await insertPet({ province: PROV, locality: LOC_A });
    for (let i = 0; i < 2; i++) await insertPet({ province: PROV, locality: LOC_B });

    const r = await fetchMicrochipPenetration(
      govtCtx([
        { province: PROV, locality: LOC_A },
        { province: PROV, locality: LOC_B },
      ]),
    );
    const visibleKeys = (r.byLocality.value as ReadonlyArray<{ key: string }>).map((c) => c.key);
    expect(visibleKeys).toContain(LOC_A);
    expect(visibleKeys).not.toContain(LOC_B);
    expect(r.byLocality.suppressedCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// C1 — Microchip penetration by province (U5 choropleth parity)
// ---------------------------------------------------------------------------

describe("fetchMicrochipPenetrationByProvince (U5)", () => {
  it("computes chipped/active ratio per province and excludes pets outside jurisdiction", async () => {
    const a1 = await insertPet({ province: PROV, locality: LOC_A });
    await insertPet({ province: PROV, locality: LOC_A });
    await insertChip(a1, { iso: true });
    // Out of scope (different province) — must NOT count.
    const out = await insertPet({ province: "Buenos Aires", locality: "La Plata" });
    await insertChip(out, { iso: true });

    const rows = await fetchMicrochipPenetrationByProvince(
      govtCtx([{ province: PROV, locality: LOC_A }]),
    );
    const row = rows.find((r) => r.province === PROV);
    expect(row).toBeDefined();
    expect(row?.active).toBe(2);
    expect(row?.chipped).toBe(1);
    expect(row?.ratePct).toBe(50);
  });

  it("returns an empty array for govt with no jurisdictions without hitting DB", async () => {
    const rows = await fetchMicrochipPenetrationByProvince(govtCtx([]));
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C2 — ISO-validity rate
// ---------------------------------------------------------------------------

describe("fetchIsoValidity (C2)", () => {
  it("rate = valid-ISO chipped / all chipped", async () => {
    const p1 = await insertPet({ province: PROV, locality: LOC_A });
    const p2 = await insertPet({ province: PROV, locality: LOC_A });
    await insertChip(p1, { iso: true }); // valid decomposed ISO
    await insertChip(p2, { iso: false }); // chipped but malformed/missing ISO fields

    const r = await fetchIsoValidity(govtCtx([{ province: PROV, locality: LOC_A }]));
    expect(r.chipped).toBe(2);
    expect(r.valid).toBe(1);
    expect(r.ratePct).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// C5 — Chip-fraud signal
// ---------------------------------------------------------------------------

describe("fetchChipReplacementSignal (C5)", () => {
  it("buckets microchip_replaced by reason; isolates fraud + duplicate", async () => {
    const p = await insertPet({ province: PROV, locality: LOC_A });
    await emitEvent(p, "microchip_replaced", {
      previous_chip_number: "111",
      new_chip_number: "222",
      reason: "fraud_detected",
    });
    await emitEvent(p, "microchip_replaced", {
      previous_chip_number: "333",
      new_chip_number: "444",
      reason: "duplicate_detected",
    });
    await emitEvent(p, "microchip_replaced", {
      previous_chip_number: "555",
      new_chip_number: "666",
      reason: "damaged",
    });

    const r = await fetchChipReplacementSignal(govtCtx([{ province: PROV, locality: LOC_A }]));
    expect(r.total).toBe(3);
    expect(r.byReason.fraud_detected).toBe(1);
    expect(r.byReason.duplicate_detected).toBe(1);
    expect(r.byReason.damaged).toBe(1);
    // fraud + duplicate are the human-review highlight.
    expect(r.flaggedForReview).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// C7 — Dangerous-breed registry compliance (graceful 0%)
// ---------------------------------------------------------------------------

describe("fetchDangerousBreedCompliance (C7)", () => {
  it("reads graceful 0% when no attestation events exist yet (registry adoption = 0%)", async () => {
    // 2 PPP-flagged pets in scope, NONE attested → honest 0%.
    await insertPet({ province: PROV, locality: LOC_A, ppp: true });
    await insertPet({ province: PROV, locality: LOC_A, ppp: true });

    const r = await fetchDangerousBreedCompliance(govtCtx([{ province: PROV, locality: LOC_A }]));
    expect(r.flaggedCount).toBe(2);
    expect(r.attested).toBe(0);
    expect(r.ratePct).toBe(0);
  });

  it("computes the attested ratio once attestation events exist", async () => {
    const a = await insertPet({ province: PROV, locality: LOC_B, ppp: true });
    await insertPet({ province: PROV, locality: LOC_B, ppp: true });
    await emitEvent(a, "dangerous_breed_attested", {
      registry: "prov_14107",
      registry_id: "R-1",
      attested_at: new Date().toISOString(),
    });

    const r = await fetchDangerousBreedCompliance(govtCtx([{ province: PROV, locality: LOC_B }]));
    expect(r.flaggedCount).toBe(2);
    expect(r.attested).toBe(1);
    expect(r.ratePct).toBe(50);
  });

  // T4-I1 / #753 — the exclusion the evidence rule adds, asserted END TO END
  // and not only over the predicate. This is the number an authority reads off
  // `/gob`, so "does the SQL actually apply the rule?" is a different question
  // from "is the rule right?", and `ppp-attestation-evidence.test.ts` answers
  // only the second. Before the rule, BOTH pets below counted as attested.
  it("does NOT count an attestation with no number and no institution", async () => {
    const a = await insertPet({ province: PROV, locality: LOC_B, ppp: true });
    await insertPet({ province: PROV, locality: LOC_B, ppp: true });
    await emitEvent(a, "dangerous_breed_attested", {
      registry: "prov_14107",
      registry_id: null,
      attested_at: new Date().toISOString(),
    });

    const r = await fetchDangerousBreedCompliance(govtCtx([{ province: PROV, locality: LOC_B }]));
    expect(r.flaggedCount).toBe(2);
    expect(r.attested).toBe(0);
    expect(r.ratePct).toBe(0);
  });

  // The institutional arm, over the same query. `emitEvent` stamps
  // authorRole="system" by default, which is NOT one of the arms — so this
  // overrides it, and the override is the assertion.
  it("counts a verified govt actor's attestation with no number", async () => {
    const a = await insertPet({ province: PROV, locality: LOC_B, ppp: true });
    await db.insert(petEvents).values({
      petId: a,
      eventType: "dangerous_breed_attested",
      occurredAt: new Date(),
      payload: {
        payload_version: 1,
        registry: "prov_14107",
        registry_id: null,
        attested_at: new Date().toISOString(),
      },
      authorRole: "govt",
      authorVerified: true,
      recordedByUserId: null,
    });

    const r = await fetchDangerousBreedCompliance(govtCtx([{ province: PROV, locality: LOC_B }]));
    expect(r.flaggedCount).toBe(1);
    expect(r.attested).toBe(1);
  });

  it("reports 0% with flaggedCount=0 when there are no PPP pets in scope", async () => {
    const r = await fetchDangerousBreedCompliance(
      govtCtx([{ province: PROV, locality: "CE-EMPTY" }]),
    );
    expect(r.flaggedCount).toBe(0);
    expect(r.ratePct).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C7 — PPP registry compliance by province (U5 choropleth parity)
// ---------------------------------------------------------------------------

describe("fetchPppComplianceByProvince (U5)", () => {
  it("computes attested/flagged ratio per province", async () => {
    const a = await insertPet({ province: PROV, locality: LOC_A, ppp: true });
    await insertPet({ province: PROV, locality: LOC_A, ppp: true });
    await emitEvent(a, "dangerous_breed_attested", {
      registry: "prov_14107",
      registry_id: "R-1",
      attested_at: new Date().toISOString(),
    });

    const rows = await fetchPppComplianceByProvince(govtCtx([{ province: PROV, locality: LOC_A }]));
    const row = rows.find((r) => r.province === PROV);
    expect(row).toBeDefined();
    expect(row?.flaggedCount).toBe(2);
    expect(row?.attested).toBe(1);
    expect(row?.ratePct).toBe(50);
  });

  it("returns an empty array for govt with no jurisdictions without hitting DB", async () => {
    const rows = await fetchPppComplianceByProvince(govtCtx([]));
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D4 — Reunification rate
// ---------------------------------------------------------------------------

describe("fetchReunificationRate (D4)", () => {
  it("rate = recovered episodes / all lost; deceased excluded; median days computed", async () => {
    // Recovered: lost 10d ago, recovered 4d ago (6 days to recovery).
    const recovered = await insertPet({ province: PROV, locality: LOC_A, status: "active" });
    await emitEvent(
      recovered,
      "status_changed",
      { from_status: "active", to_status: "lost" },
      new Date(Date.now() - 10 * DAY_MS),
    );
    await emitEvent(
      recovered,
      "status_changed",
      { from_status: "lost", to_status: "active" },
      new Date(Date.now() - 4 * DAY_MS),
    );
    // Still lost.
    const stillLost = await insertPet({ province: PROV, locality: LOC_A, status: "lost" });
    await emitEvent(
      stillLost,
      "status_changed",
      { from_status: "active", to_status: "lost" },
      new Date(Date.now() - 8 * DAY_MS),
    );
    // Lost then deceased — must NOT count as recovered.
    const deceased = await insertPet({ province: PROV, locality: LOC_A, status: "deceased" });
    await emitEvent(
      deceased,
      "status_changed",
      { from_status: "active", to_status: "lost" },
      new Date(Date.now() - 9 * DAY_MS),
    );
    await emitEvent(
      deceased,
      "status_changed",
      { from_status: "lost", to_status: "deceased" },
      new Date(Date.now() - 3 * DAY_MS),
    );

    const r = await fetchReunificationRate(govtCtx([{ province: PROV, locality: LOC_A }]));
    expect(r.lostEpisodes).toBe(3);
    expect(r.recovered).toBe(1);
    // 1/3 → 33,3% — one-decimal precision survives the fetcher (audit 2026-07-07).
    expect(r.ratePct).toBe(33.3);
    expect(r.medianDaysToRecovery).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// D5 — Seizures (decomisos)
// ---------------------------------------------------------------------------

describe("fetchSeizures (D5)", () => {
  it("counts shelter_intake_recorded(intake_reason='seizure') by motive; excludes non-seizure + out-of-scope", async () => {
    const p1 = await insertPet({ province: PROV, locality: LOC_A });
    const p2 = await insertPet({ province: PROV, locality: LOC_A });
    await emitEvent(p1, "shelter_intake_recorded", {
      intake_reason: "seizure",
      intake_condition: null,
      rescue_jurisdiction: null,
      seizure_motive: "maltrato_fisico",
    });
    await emitEvent(p2, "shelter_intake_recorded", {
      intake_reason: "seizure",
      intake_condition: null,
      rescue_jurisdiction: null,
      seizure_motive: "abandono_extremo",
    });
    // A non-seizure intake must be ignored.
    await emitEvent(p1, "shelter_intake_recorded", {
      intake_reason: "rescue",
      intake_condition: null,
      rescue_jurisdiction: null,
    });
    // Out-of-scope seizure must NOT count.
    const out = await insertPet({ province: "Buenos Aires", locality: "La Plata" });
    await emitEvent(out, "shelter_intake_recorded", {
      intake_reason: "seizure",
      intake_condition: null,
      rescue_jurisdiction: null,
      seizure_motive: "trafico",
    });

    const r = await fetchSeizures(govtCtx([{ province: PROV, locality: LOC_A }]));
    expect(r.total).toBe(2);
    const byMotive = Object.fromEntries(r.byMotive.map((m) => [m.motive, m.count]));
    expect(byMotive.maltrato_fisico).toBe(1);
    expect(byMotive.abandono_extremo).toBe(1);
    expect(byMotive.trafico).toBeUndefined();
  });

  it("returns zero shape for govt with no jurisdictions", async () => {
    const r = await fetchSeizures(govtCtx([]));
    expect(r.total).toBe(0);
    expect(r.byMotive).toEqual([]);
  });
});
