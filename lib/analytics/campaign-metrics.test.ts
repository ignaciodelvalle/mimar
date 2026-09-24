// Tests for campaign-metrics.ts — pure projection logic and integration seeds.
//
// Tests cover:
//  1. computeDelta — pure arithmetic (no DB)
//  2. formatDelta  — null-safety and shape
//  3. fetchCampaignDashboard — integration over test seed (bookings + attendance)
//
// Integration tests run against the local Postgres instance that has bootstrapped
// schema. They seed data and clean up in afterAll to avoid pollution.

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appointments, db, organizations, pets, profiles, serviceOfferings, timeSlots } from "@/db";
import { buildProjectionContext } from "@/lib/metrics";
import { ANONYMITY_K } from "@/lib/metrics/anonymity";
import {
  type CampaignGeoReach,
  type CampaignOutcomeRow,
  aggregateCampaignOutcomes,
  computeDelta,
  fetchCampaignDashboard,
  formatDelta,
  hasCampaignsInScope,
  isSanitaryOutcomeEvent,
  suppressGeoReach,
} from "./campaign-metrics";

// ---------------------------------------------------------------------------
// Pure unit tests — no DB
// ---------------------------------------------------------------------------

describe("computeDelta", () => {
  it("returns null when previous is 0 (division undefined)", () => {
    expect(computeDelta(10, 0)).toBeNull();
  });

  it("returns 0 when current equals previous", () => {
    expect(computeDelta(50, 50)).toBe(0);
  });

  it("returns positive delta when current > previous", () => {
    expect(computeDelta(110, 100)).toBe(10);
  });

  it("returns negative delta when current < previous", () => {
    expect(computeDelta(80, 100)).toBe(-20);
  });

  it("rounds to the nearest integer", () => {
    expect(computeDelta(115, 100)).toBe(15);
    // 33.33... → rounds to 33
    expect(computeDelta(133, 100)).toBe(33);
  });
});

describe("formatDelta", () => {
  it("returns null when previous is 0", () => {
    expect(formatDelta(10, 0, "vs período anterior")).toBeNull();
  });

  it("returns { value, period } with correct numeric delta", () => {
    const result = formatDelta(120, 100, "vs mes anterior");
    expect(result).toEqual({ value: 20, period: "vs mes anterior" });
  });

  it("negative delta is preserved", () => {
    const result = formatDelta(80, 100, "vs período anterior");
    expect(result).toEqual({ value: -20, period: "vs período anterior" });
  });
});

describe("isSanitaryOutcomeEvent", () => {
  it("accepts the three sanitary prestación event types", () => {
    expect(isSanitaryOutcomeEvent("vaccination_administered")).toBe(true);
    expect(isSanitaryOutcomeEvent("sterilization_performed")).toBe(true);
    expect(isSanitaryOutcomeEvent("deworming_administered")).toBe(true);
  });

  it("rejects non-sanitary event types (logistics/fallback do not count)", () => {
    expect(isSanitaryOutcomeEvent("vet_visit_logged")).toBe(false);
    expect(isSanitaryOutcomeEvent("microchip_implanted")).toBe(false);
    expect(isSanitaryOutcomeEvent("pet_registered")).toBe(false);
    expect(isSanitaryOutcomeEvent("")).toBe(false);
  });
});

describe("aggregateCampaignOutcomes — pure projection over synthetic events", () => {
  it("returns an empty map for no rows", () => {
    expect(aggregateCampaignOutcomes([]).size).toBe(0);
  });

  it("counts one sanitary prestación per linked outcome event, grouped by offering", () => {
    // Synthetic events: offering A produced 2 vaccinations + 1 sterilization,
    // offering B produced 1 deworming.
    const rows: CampaignOutcomeRow[] = [
      { offeringId: "A", eventType: "vaccination_administered" },
      { offeringId: "A", eventType: "vaccination_administered" },
      { offeringId: "A", eventType: "sterilization_performed" },
      { offeringId: "B", eventType: "deworming_administered" },
    ];
    const result = aggregateCampaignOutcomes(rows);
    expect(result.get("A")).toBe(3);
    expect(result.get("B")).toBe(1);
  });

  it("excludes non-sanitary outcome events (vet_visit_logged / microchip fallback)", () => {
    // Two attended appointments produced non-sanitary events → must not count.
    const rows: CampaignOutcomeRow[] = [
      { offeringId: "A", eventType: "vaccination_administered" },
      { offeringId: "A", eventType: "vet_visit_logged" },
      { offeringId: "A", eventType: "microchip_implanted" },
    ];
    const result = aggregateCampaignOutcomes(rows);
    // Only the vaccination counts — conversion attended(3) → prestación(1) is honest.
    expect(result.get("A")).toBe(1);
  });

  it("omits offerings with zero sanitary events from the map", () => {
    const rows: CampaignOutcomeRow[] = [{ offeringId: "A", eventType: "vet_visit_logged" }];
    const result = aggregateCampaignOutcomes(rows);
    expect(result.has("A")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// suppressGeoReach — k-anonymity on geo reach (pure, no DB)
//
// Test-pins the F1 fix: government-facing campaign attendance by locality must
// never ship a < k count (a locality with 2 vaccinated animals is individually
// identifiable), on the table OR the CSV export.
// ---------------------------------------------------------------------------

describe("suppressGeoReach — k-anonymity (k=5)", () => {
  it("returns empty rows + zero suppressed for no cells", () => {
    expect(suppressGeoReach([])).toEqual({ rows: [], suppressedCount: 0 });
  });

  it("keeps localities with count ≥ k, with their exact count", () => {
    const cells: CampaignGeoReach[] = [
      { locality: "La Plata", province: "Buenos Aires", attendedCount: 12 },
      { locality: "Mar del Plata", province: "Buenos Aires", attendedCount: 5 },
    ];
    const result = suppressGeoReach(cells);
    expect(result.suppressedCount).toBe(0);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.find((r) => r.locality === "La Plata")?.attendedCount).toBe(12);
    // Exactly at the threshold (5) stays visible.
    expect(result.rows.find((r) => r.locality === "Mar del Plata")?.attendedCount).toBe(5);
  });

  it("suppresses localities with count < k and never exposes them by name", () => {
    const cells: CampaignGeoReach[] = [
      { locality: "La Plata", province: "Buenos Aires", attendedCount: 12 },
      { locality: "Villa Chica", province: "Buenos Aires", attendedCount: 2 },
      { locality: "Villa Menor", province: "Buenos Aires", attendedCount: 4 },
    ];
    const result = suppressGeoReach(cells);
    expect(result.suppressedCount).toBe(2);
    // The sub-threshold localities are gone by name.
    expect(result.rows.find((r) => r.locality === "Villa Chica")).toBeUndefined();
    expect(result.rows.find((r) => r.locality === "Villa Menor")).toBeUndefined();
    // NO ROW AT ALL may carry a sub-threshold count, whatever it is called.
    //
    // This assertion used to read `r.locality === "Villa Chica" &&
    // r.attendedCount === 2` — vacuous by construction: the suppressed locality
    // is never emitted under its own name, so the conjunction could not be true
    // even while the rollup published that exact 2 under a privacy label. It
    // LOOKED like it was guarding the leak and guarded nothing.
    const subThreshold = result.rows.filter((r) => r.attendedCount < ANONYMITY_K);
    expect(subThreshold).toEqual([]);
    // Non-vacuity: the input really did contain sub-threshold cells to hide.
    expect(cells.filter((c) => c.attendedCount < ANONYMITY_K)).toHaveLength(2);
  });

  it("folds suppressed localities into ONE per-province rollup that preserves the total", () => {
    const cells: CampaignGeoReach[] = [
      { locality: "La Plata", province: "Buenos Aires", attendedCount: 12 },
      { locality: "Villa Chica", province: "Buenos Aires", attendedCount: 2 },
      { locality: "Villa Menor", province: "Buenos Aires", attendedCount: 4 },
    ];
    const result = suppressGeoReach(cells);
    const rollup = result.rows.find((r) => r.locality === "Otras localidades (privacidad)");
    expect(rollup).toBeDefined();
    expect(rollup?.province).toBe("Buenos Aires");
    // 2 + 4 preserved at province granularity (locality identity withheld).
    expect(rollup?.attendedCount).toBe(6);
  });

  it("keeps rollups separated per province (no cross-province lumping)", () => {
    // Each province needs enough hidden localities to clear k on its own,
    // otherwise its rollup is dropped (see the test below) and this would be
    // asserting the drop rather than the separation.
    const cells: CampaignGeoReach[] = [
      { locality: "Villa Chica", province: "Buenos Aires", attendedCount: 2 },
      { locality: "Villa Menor", province: "Buenos Aires", attendedCount: 4 },
      { locality: "Pueblo Chico", province: "Córdoba", attendedCount: 3 },
      { locality: "Pueblo Menor", province: "Córdoba", attendedCount: 3 },
    ];
    const result = suppressGeoReach(cells);
    expect(result.suppressedCount).toBe(4);
    const rollups = result.rows.filter((r) => r.locality === "Otras localidades (privacidad)");
    expect(rollups).toHaveLength(2);
    expect(rollups.find((r) => r.province === "Buenos Aires")?.attendedCount).toBe(6);
    expect(rollups.find((r) => r.province === "Córdoba")?.attendedCount).toBe(6);
  });

  it("THE LEAK: a province with ONE hidden locality gets NO rollup — the rollup is a cell too", () => {
    // Reversed on purpose (closing report M5 / fix queue row 14). The previous
    // version of this file asserted rollups of 2 and 3, built from single hidden
    // localities of 2 and 3 — i.e. it pinned the exact numbers the suppression
    // was protecting, republished under the label "Otras localidades
    // (privacidad)". Whoever fixed the bug would have found a red test and
    // assumed they were wrong. The project already learned this on
    // /gob/mortalidad ("Tierra del Fuego (otras localidades) — 2", found live
    // 2026-07-28) and wrote the rule down in rollupSuppressedLocalities; the
    // campaigns module claimed to use "the same proven pattern" and rolled its
    // own without the check.
    const cells: CampaignGeoReach[] = [
      { locality: "La Plata", province: "Buenos Aires", attendedCount: 12 },
      { locality: "Villa Chica", province: "Buenos Aires", attendedCount: 2 },
      { locality: "Pueblo Chico", province: "Córdoba", attendedCount: 3 },
    ];
    const result = suppressGeoReach(cells);

    // Both hidden localities are still COUNTED — the page can say how many were
    // hidden without saying how many attendances they hold.
    expect(result.suppressedCount).toBe(2);

    // Neither province publishes a rollup: 2 < k and 3 < k.
    expect(result.rows.filter((r) => r.locality === "Otras localidades (privacidad)")).toEqual([]);
    // And nothing else picked up the residue.
    expect(result.rows.map((r) => r.attendedCount)).toEqual([12]);
  });

  it("boundary: a fold of exactly k publishes, k-1 does not", () => {
    const foldTo = (counts: number[]): CampaignGeoReach[] =>
      counts.map((n, i) => ({
        locality: `Chica ${i}`,
        province: "Buenos Aires",
        attendedCount: n,
      }));

    // 2 + 2 = 4 = k-1 → dropped.
    const under = suppressGeoReach(foldTo([2, 2]));
    expect(under.rows).toEqual([]);
    expect(under.suppressedCount).toBe(2);

    // 2 + 3 = 5 = k → published, total preserved.
    const at = suppressGeoReach(foldTo([2, 3]));
    expect(at.rows).toHaveLength(1);
    expect(at.rows[0].locality).toBe("Otras localidades (privacidad)");
    expect(at.rows[0].attendedCount).toBe(ANONYMITY_K);
  });

  it("returns rows sorted by attendance descending", () => {
    const cells: CampaignGeoReach[] = [
      { locality: "Small", province: "Buenos Aires", attendedCount: 6 },
      { locality: "Big", province: "Buenos Aires", attendedCount: 20 },
    ];
    const result = suppressGeoReach(cells);
    expect(result.rows.map((r) => r.locality)).toEqual(["Big", "Small"]);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — require local Postgres + bootstrapped schema
// ---------------------------------------------------------------------------

const TEST_PROVINCE = "Buenos Aires";
const TEST_LOCALITY = "test-locality-campaigns-int";
const ORG_TOKEN = `ORG-CAM-TST-${Date.now()}`;
const PET_TOKEN = `PET-CAM-TST-${Date.now()}`;

let orgId: string;
let ownerId: string;
let petId: string;
let offeringId: string;
let slotId: string;
const createdAppointmentIds: string[] = [];

beforeAll(async () => {
  // Insert test org (requires legalName + email).
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN,
      legalName: "Campañas Test Org SRL",
      displayName: "Test Org Campañas",
      orgType: "clinic",
      email: "campaigns-test@dim-test.local",
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
    })
    .returning({ id: organizations.id });
  orgId = org.id;

  // Insert test profile (profiles table uses Supabase auth UUID — we supply our own).
  const profileId = crypto.randomUUID();
  await db.insert(profiles).values({
    id: profileId,
    displayName: "Test Owner Campañas",
    role: "owner",
  });
  ownerId = profileId;

  // Insert test pet (no ownerUserId on pets — ownership is in ownerships table).
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "TestDog",
      species: "dog",
      status: "active",
      potentiallyDangerousBreed: false,
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
    })
    .returning({ id: pets.id });
  petId = pet.id;

  // Insert approved service offering.
  const [offering] = await db
    .insert(serviceOfferings)
    .values({
      publicToken: `SVO-CAM-TST-${Date.now()}`,
      organizationId: orgId,
      serviceKind: "vaccination",
      displayName: "Vacunación antirrábica test",
      durationMinutes: 15,
      slotCapacity: 5,
      status: "approved",
      jurisdictionProvince: TEST_PROVINCE,
      jurisdictionLocality: TEST_LOCALITY,
      submittedAt: new Date(),
    })
    .returning({ id: serviceOfferings.id });
  offeringId = offering.id;

  // Insert a time slot.
  const slotStart = new Date();
  slotStart.setHours(10, 0, 0, 0);
  const slotEnd = new Date(slotStart.getTime() + 15 * 60_000);
  const [slot] = await db
    .insert(timeSlots)
    .values({
      serviceOfferingId: offeringId,
      startsAt: slotStart,
      endsAt: slotEnd,
      capacity: 5,
      bookingsCount: 0,
      status: "open",
    })
    .returning({ id: timeSlots.id });
  slotId = slot.id;
});

afterAll(async () => {
  // Clean up in FK order.
  if (createdAppointmentIds.length > 0) {
    for (const id of createdAppointmentIds) {
      await db.delete(appointments).where(eq(appointments.id, id));
    }
  }
  if (offeringId) {
    // Deleting offering cascades to timeSlots.
    await db.delete(serviceOfferings).where(eq(serviceOfferings.id, offeringId));
  }
  if (petId) {
    await db.delete(pets).where(eq(pets.id, petId));
  }
  if (ownerId) {
    await db.delete(profiles).where(eq(profiles.id, ownerId));
  }
  if (orgId) {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }
});

describe("fetchCampaignDashboard — integration", () => {
  it("returns empty dashboard when jurisdiction has no offerings", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: "Neuquén", locality: "no-offerings-here-campaign" }],
      { since: new Date(Date.now() - 30 * 86400_000), until: new Date() },
    );
    const result = await fetchCampaignDashboard(ctx);
    expect(result.offerings).toHaveLength(0);
    expect(result.totals.enrollment).toBe(0);
    expect(result.totals.completion).toBe(0);
    expect(result.totals.noShow).toBe(0);
    expect(result.totals.completionRate).toBeNull();
    expect(result.geoReach.rows).toHaveLength(0);
    expect(result.geoReach.suppressedCount).toBe(0);
  });

  it("counts enrollment as confirmed + attended + no_show (not cancelled)", async () => {
    // Seed: 2 attended + 1 no_show + 1 confirmed = 4 enrollment.
    const newAppts = await db
      .insert(appointments)
      .values([
        {
          publicToken: `APT-A1-${Date.now()}`,
          slotId,
          petId,
          ownerUserId: ownerId,
          serviceOfferingId: offeringId,
          organizationId: orgId,
          status: "attended",
          attendedAt: new Date(),
          attendedByUserId: ownerId,
        },
        {
          publicToken: `APT-A2-${Date.now()}-2`,
          slotId,
          petId,
          ownerUserId: ownerId,
          serviceOfferingId: offeringId,
          organizationId: orgId,
          status: "attended",
          attendedAt: new Date(),
          attendedByUserId: ownerId,
        },
        {
          publicToken: `APT-NS-${Date.now()}-3`,
          slotId,
          petId,
          ownerUserId: ownerId,
          serviceOfferingId: offeringId,
          organizationId: orgId,
          status: "no_show",
          noShowMarkedAt: new Date(),
        },
        {
          publicToken: `APT-CF-${Date.now()}-4`,
          slotId,
          petId,
          ownerUserId: ownerId,
          serviceOfferingId: offeringId,
          organizationId: orgId,
          status: "confirmed",
        },
      ])
      .returning({ id: appointments.id });
    createdAppointmentIds.push(...newAppts.map((r) => r.id));

    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: TEST_PROVINCE, locality: TEST_LOCALITY }],
      { since: new Date(Date.now() - 7 * 86400_000), until: new Date(Date.now() + 86400_000) },
    );

    const result = await fetchCampaignDashboard(ctx);

    // At least the 4 appointments we seeded above.
    expect(result.totals.enrollment).toBeGreaterThanOrEqual(4);
    expect(result.totals.completion).toBeGreaterThanOrEqual(2);
    expect(result.totals.noShow).toBeGreaterThanOrEqual(1);
  });

  it("admin context (global scope) sees the seeded offering", async () => {
    const ctx = buildProjectionContext({ role: "admin" }, [], {
      since: new Date(Date.now() - 7 * 86400_000),
      until: new Date(Date.now() + 86400_000),
    });
    const result = await fetchCampaignDashboard(ctx);
    const found = result.offerings.find((o) => o.offeringId === offeringId);
    expect(found).toBeDefined();
    expect(found?.displayName).toBe("Vacunación antirrábica test");
  });

  it("completionRate and noShowRate are null when enrollment is 0 in period", async () => {
    // Use a time window far in the future — no appointments seeded there.
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: TEST_PROVINCE, locality: TEST_LOCALITY }],
      {
        since: new Date(Date.now() + 10 * 365 * 86400_000),
        until: new Date(Date.now() + 11 * 365 * 86400_000),
      },
    );
    const result = await fetchCampaignDashboard(ctx);
    // The offering exists in this jurisdiction but has no appointments in the future window.
    const found = result.offerings.find((o) => o.offeringId === offeringId);
    expect(found).toBeDefined();
    expect(found?.enrollment).toBe(0);
    expect(found?.completionRate).toBeNull();
    expect(found?.noShowRate).toBeNull();
  });

  it("enrollmentSparkline returns an array of exactly 6 numbers", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: TEST_PROVINCE, locality: TEST_LOCALITY }],
      { since: new Date(Date.now() - 30 * 86400_000), until: new Date() },
    );
    const result = await fetchCampaignDashboard(ctx);
    expect(result.enrollmentSparkline).toHaveLength(6);
    for (const n of result.enrollmentSparkline) {
      expect(typeof n).toBe("number");
      expect(n).toBeGreaterThanOrEqual(0);
    }
  });

  it("geoReach shows a locality with ≥5 attendances (above the k-anon threshold)", async () => {
    // Seed 5 attended appointments so the locality clears k=5 and stays visible
    // by name — a locality below the threshold is suppressed (see the dedicated
    // suppressGeoReach unit tests and the suppression integration test below).
    const geoAppts = await db
      .insert(appointments)
      .values(
        Array.from({ length: 5 }, (_, i) => ({
          publicToken: `APT-GEO-${Date.now()}-${i}`,
          slotId,
          petId,
          ownerUserId: ownerId,
          serviceOfferingId: offeringId,
          organizationId: orgId,
          status: "attended" as const,
          attendedAt: new Date(),
          attendedByUserId: ownerId,
        })),
      )
      .returning({ id: appointments.id });
    createdAppointmentIds.push(...geoAppts.map((r) => r.id));

    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: TEST_PROVINCE, locality: TEST_LOCALITY }],
      { since: new Date(Date.now() - 7 * 86400_000), until: new Date(Date.now() + 86400_000) },
    );

    const result = await fetchCampaignDashboard(ctx);
    const geo = result.geoReach.rows.find((g) => g.locality === TEST_LOCALITY);
    expect(geo).toBeDefined();
    expect(geo?.attendedCount).toBeGreaterThanOrEqual(5);
    // No visible row may carry a raw sub-threshold count.
    for (const row of result.geoReach.rows) {
      if (row.locality !== "Otras localidades (privacidad)") {
        expect(row.attendedCount).toBeGreaterThanOrEqual(5);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// hasCampaignsInScope — T4-O3 (gob-onboarding-checklist, G3)
// ---------------------------------------------------------------------------
// Reuses the offering seeded in beforeAll above (TEST_PROVINCE/TEST_LOCALITY,
// status "approved") — no new fixtures. The mutation this guards against: a
// govt operator seeing "true" for a jurisdiction that is not theirs.

describe("hasCampaignsInScope — integration", () => {
  it("is true for a govt operator scoped to the jurisdiction that has the offering", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: TEST_PROVINCE, locality: TEST_LOCALITY }],
      { since: new Date(Date.now() - 7 * 86400_000), until: new Date(Date.now() + 86400_000) },
    );
    expect(await hasCampaignsInScope(ctx)).toBe(true);
  });

  it("is false for a govt operator scoped to a DIFFERENT jurisdiction (isolation)", async () => {
    const ctx = buildProjectionContext(
      { role: "govt" },
      [{ province: "Córdoba", locality: "otra-localidad-campanas-int" }],
      { since: new Date(Date.now() - 7 * 86400_000), until: new Date(Date.now() + 86400_000) },
    );
    expect(await hasCampaignsInScope(ctx)).toBe(false);
  });

  it("is false for a govt operator with zero jurisdictions (short-circuits, no query)", async () => {
    const ctx = buildProjectionContext({ role: "govt" }, [], {
      since: new Date(Date.now() - 7 * 86400_000),
      until: new Date(Date.now() + 86400_000),
    });
    expect(await hasCampaignsInScope(ctx)).toBe(false);
  });

  it("is true for admin (global scope, no restriction)", async () => {
    const ctx = buildProjectionContext({ role: "admin" }, [], {
      since: new Date(Date.now() - 7 * 86400_000),
      until: new Date(Date.now() + 86400_000),
    });
    expect(await hasCampaignsInScope(ctx)).toBe(true);
  });

  it("is false for admin drilled into a province with no offerings", async () => {
    // A fabricated province name — a real one (even an unrelated one, e.g.
    // "Córdoba") is not safe here: the shared local dev DB carries its own
    // seed/demo offerings across many real provinces, so only a name that
    // cannot exist in jurisdictionProvince guarantees the "no offerings" case.
    const ctx = buildProjectionContext(
      { role: "admin" },
      [],
      { since: new Date(Date.now() - 7 * 86400_000), until: new Date(Date.now() + 86400_000) },
      { adminProvince: "Provincia Ficticia T4-O3" },
    );
    expect(await hasCampaignsInScope(ctx)).toBe(false);
  });
});
