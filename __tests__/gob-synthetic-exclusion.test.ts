// T1-P1 (PO decision D3, 2026-09-18) — synthetic data is invisible to a
// government viewer, and admin keeps seeing it.
//
// Integration test — local Supabase + Postgres. One jurisdiction, two animals
// that are identical in every way the /gob surfaces look at EXCEPT
// `pets.seed_tag`: a REAL one (NULL) and a SYNTHETIC one ('panorama', the tag
// the national demo seed writes). Each gets a bite event, a bite case, an ENO
// outbox row and a welfare report (the synthetic report carries its own
// `welfare_reports.seed_tag`, as the seed writes it). Then every representative
// read path is asked, as govt, as national and as admin:
//
//   govt / national → exactly the REAL rows;   admin → both.
//
// The jurisdiction is a made-up locality so the national seed never lands in
// it — every row a fetcher returns here is one this file wrote.
//
// Representative, not exhaustive: the fence
// (__tests__/gob-synthetic-exclusion-fence.test.ts) is what holds EVERY raw
// scope to the clause; this file proves the clause does what it says on the
// helper families the fence relies on (lib/metrics/scope.ts petsScopeClause,
// _scope.ts pets-current / cases / welfare, the panorama repository scope,
// the case queue, the outbox builder, the SENASA export).

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cases, db, eventNotificationOutbox, petEvents, pets, welfareReports } from "@/db";
import { buildMaltratoListConditions } from "@/lib/analytics/dashboards/welfare";
import { fetchEventsForExport, fetchPetsForExport } from "@/lib/analytics/govt-dashboards";
import { streamSenasaBatch } from "@/lib/analytics/senasa-export-query";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { openCase } from "@/lib/infra/case-helpers";
import { listCasesForAdmin, listCasesForGovt } from "@/lib/infra/case-queries";
import { buildOutboxWhere } from "@/lib/infra/outbox-query";
import {
  type DashboardActor,
  type DashboardJurisdiction,
  buildProjectionContext,
} from "@/lib/metrics";
import {
  loadBiteEvents,
  loadMordedurassByUnit,
} from "@/src/modules/panorama/infrastructure/repository";

import { withMutationOverride } from "./_helpers/db-overrides";

const PROVINCE = "Córdoba";
const LOCALITY = "SYNTH-EXCL-T1P1"; // made up — the seed never writes it
const JURS: DashboardJurisdiction[] = [{ province: PROVINCE, locality: LOCALITY }];

const GOVT: DashboardActor = { role: "govt" };
const NATIONAL: DashboardActor = { role: "national" };
const ADMIN: DashboardActor = { role: "admin" };

const REAL_TOKEN = "DIM-SYNX-REAL";
const SYNTH_TOKEN = "DIM-SYNX-SEED";
const REAL_REF = "DEN-SYNX-REAL";
const SYNTH_REF = "DEN-SYNX-SEED";
const NOBODY = "00000000-0000-4000-8000-000000000918";

// One fixed instant, two days back: every window below is built around it, so
// no assertion compares the host clock against a defaultNow() column.
const OCCURRED_AT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
const SINCE = new Date(OCCURRED_AT.getTime() - 60 * 60 * 1000);
const NARROW = {
  since: new Date(OCCURRED_AT.getTime() - 1000),
  until: new Date(OCCURRED_AT.getTime() + 1000),
};

type Fixture = { petId: string; eventId: string; caseId: string; outboxId: string };
let real: Fixture;
let synth: Fixture;

async function cleanup(): Promise<void> {
  await withMutationOverride(async (tx) => {
    await tx.execute(
      sql`UPDATE welfare_reports SET case_id = NULL WHERE reference_code IN (${REAL_REF}, ${SYNTH_REF})`,
    );
    await tx.execute(sql`DELETE FROM event_notification_outbox WHERE source_event_id IN (
      SELECT pe.id FROM pet_events pe JOIN pets p ON p.id = pe.pet_id
      WHERE p.public_token IN (${REAL_TOKEN}, ${SYNTH_TOKEN}))`);
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token IN (${REAL_TOKEN}, ${SYNTH_TOKEN}))`);
    await tx.execute(sql`DELETE FROM case_events WHERE case_id IN (
      SELECT c.id FROM cases c JOIN pets p ON p.id = c.primary_pet_id
      WHERE p.public_token IN (${REAL_TOKEN}, ${SYNTH_TOKEN}))`);
    await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
      SELECT id FROM pets WHERE public_token IN (${REAL_TOKEN}, ${SYNTH_TOKEN}))`);
    await tx.execute(
      sql`DELETE FROM welfare_reports WHERE reference_code IN (${REAL_REF}, ${SYNTH_REF})`,
    );
    await tx.execute(sql`DELETE FROM pets WHERE public_token IN (${REAL_TOKEN}, ${SYNTH_TOKEN})`);
  });
}

async function seedAnimal(token: string, seedTag: string | null, lng: string): Promise<Fixture> {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: seedTag ? "Sintetico" : "Real",
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: LOCALITY,
      seedTag,
    })
    .returning({ id: pets.id });

  const [event] = await db
    .insert(petEvents)
    .values({
      petId: pet.id,
      eventType: "incident_reported",
      occurredAt: OCCURRED_AT,
      payload: validateEventPayload("incident_reported", {
        incident_type: "bite_inflicted",
        severity: "moderate",
        injuries_summary: null,
        vet_involved: null,
      }) as Record<string, unknown>,
      authorRole: "owner",
      recordedByUserId: null,
      locationLat: "-31.4000000",
      locationLng: lng,
      // Any SENASA-aligned code makes the row a SENASA export row; the export
      // selects on tipo_evento_code alone. The FK only needs an existing code.
      tipoEventoCode: "vacunacion_antirrabica",
    })
    .returning({ id: petEvents.id });

  const caseRow = await openCase({
    kind: "bite_incident",
    primarySubjectKind: "registered_pet",
    primaryPetId: pet.id,
    jurisdictionProvince: PROVINCE,
    jurisdictionLocality: LOCALITY,
    openedReason: { code: "bite_reported_owner", victimKind: "human", severity: "moderate" },
  });

  const [outbox] = await db
    .insert(eventNotificationOutbox)
    .values({
      sourceEventId: event.id,
      targetKind: "eno_authority",
      targetJurisdictionProvince: PROVINCE,
      targetJurisdictionLocality: LOCALITY,
      slaDueAt: new Date(OCCURRED_AT.getTime() + 24 * 60 * 60 * 1000),
    })
    .returning({ id: eventNotificationOutbox.id });

  await db.insert(welfareReports).values({
    referenceCode: seedTag ? SYNTH_REF : REAL_REF,
    kind: "neglect",
    severity: "high",
    description: "fixture report for the T1-P1 synthetic exclusion test.",
    subjectKind: "registered_pet",
    subjectPetId: pet.id,
    status: "open",
    jurisdictionProvince: PROVINCE,
    jurisdictionLocality: LOCALITY,
    seedTag: seedTag ? "PANO" : null,
  });

  return { petId: pet.id, eventId: event.id, caseId: caseRow.id, outboxId: outbox.id };
}

beforeAll(async () => {
  await cleanup();
  real = await seedAnimal(REAL_TOKEN, null, "-64.1000000");
  synth = await seedAnimal(SYNTH_TOKEN, "panorama", "-64.2000000");
}, 60_000);

afterAll(cleanup, 60_000);

describe("pets (petsScopeClause) — row-level PD1 pets export", () => {
  it("govt sees exactly the real pet", async () => {
    const rows = await fetchPetsForExport(GOVT, JURS);
    expect(rows.map((r) => r.publicToken)).toEqual([REAL_TOKEN]);
  });

  it("national sees exactly the real pet — universal geography, real data", async () => {
    const rows = await fetchPetsForExport(NATIONAL, [], {}, PROVINCE, LOCALITY);
    expect(rows.map((r) => r.publicToken)).toEqual([REAL_TOKEN]);
  });

  it("admin sees both", async () => {
    const rows = await fetchPetsForExport(ADMIN, [], {}, PROVINCE, LOCALITY);
    expect(rows.map((r) => r.publicToken).sort()).toEqual([REAL_TOKEN, SYNTH_TOKEN].sort());
  });
});

describe("pet_events (petsCurrentJurisdictionClause) — row-level PD1 events export", () => {
  it("govt sees only the real animal's events; admin sees both", async () => {
    const govt = await fetchEventsForExport(GOVT, JURS);
    expect([...new Set(govt.map((r) => r.petPublicToken))]).toEqual([REAL_TOKEN]);
    const admin = await fetchEventsForExport(ADMIN, [], {}, PROVINCE, LOCALITY);
    expect([...new Set(admin.map((r) => r.petPublicToken))].sort()).toEqual(
      [REAL_TOKEN, SYNTH_TOKEN].sort(),
    );
  });
});

describe("SENASA export (streamSenasaBatch)", () => {
  async function tokens(actor: DashboardActor, jurisdictions: DashboardJurisdiction[]) {
    const out: string[] = [];
    for await (const row of streamSenasaBatch(
      buildProjectionContext(actor, jurisdictions, NARROW),
    )) {
      if (row.animalToken === REAL_TOKEN || row.animalToken === SYNTH_TOKEN) {
        out.push(row.animalToken);
      }
    }
    return out.sort();
  }

  it("govt exports only the real animal; admin exports both", async () => {
    expect(await tokens(GOVT, JURS)).toEqual([REAL_TOKEN]);
    expect(await tokens(ADMIN, [])).toEqual([REAL_TOKEN, SYNTH_TOKEN].sort());
  });
});

describe("cases — the /gob/casos queue", () => {
  it("govt lists only the real animal's case; admin lists both", async () => {
    const govt = await listCasesForGovt(JURS, { limit: 50 });
    expect(govt.map((c) => c.id)).toEqual([real.caseId]);
    const admin = await listCasesForAdmin({
      limit: 50,
      filters: { province: PROVINCE, locality: LOCALITY },
    });
    expect(admin.map((c) => c.id).sort()).toEqual([real.caseId, synth.caseId].sort());
  });
});

describe("welfare_reports — the /gob/maltrato queue", () => {
  async function refs(actor: DashboardActor, jurisdictions: DashboardJurisdiction[]) {
    const where = buildMaltratoListConditions({
      actor,
      filteredJurisdictions: jurisdictions,
      queue: "all",
      selectedProvince: actor.role === "admin" ? PROVINCE : null,
      selectedLocality: actor.role === "admin" ? LOCALITY : null,
      currentUserId: NOBODY,
    });
    const rows = await db
      .select({ ref: welfareReports.referenceCode })
      .from(welfareReports)
      .where(and(where, inArray(welfareReports.referenceCode, [REAL_REF, SYNTH_REF])));
    return rows.map((r) => r.ref).sort();
  }

  it("govt sees only the real denuncia; admin sees both", async () => {
    expect(await refs(GOVT, JURS)).toEqual([REAL_REF]);
    expect(await refs(ADMIN, [])).toEqual([REAL_REF, SYNTH_REF].sort());
  });
});

describe("ENO outbox — /gob/outbox vs /admin/outbox", () => {
  async function ids(jurisdiction: DashboardJurisdiction[] | undefined) {
    const where = buildOutboxWhere({ province: PROVINCE }, { jurisdiction, cursor: null });
    const rows = await db
      .select({ id: eventNotificationOutbox.id })
      .from(eventNotificationOutbox)
      .where(and(where, inArray(eventNotificationOutbox.id, [real.outboxId, synth.outboxId])));
    return rows.map((r) => r.id).sort();
  }

  it("the govt twin lists only the real notification; the admin twin lists both", async () => {
    expect(await ids(JURS)).toEqual([real.outboxId]);
    expect(await ids(undefined)).toEqual([real.outboxId, synth.outboxId].sort());
  });
});

describe("panorama — live loaders (the cube is admin-only, see load-layer-features-cube)", () => {
  it("govt gets one bite dot (the real one); admin drilled into the unit gets both", async () => {
    const govt = await loadBiteEvents(GOVT, JURS, SINCE);
    expect(govt.rows.map((r) => r.id)).toEqual([real.eventId]);
    const admin = await loadBiteEvents(ADMIN, [], SINCE, undefined, PROVINCE, LOCALITY);
    expect(admin.rows.map((r) => r.id).sort()).toEqual([real.eventId, synth.eventId].sort());
  });

  it("the cell the exclusion drops under k is SUPPRESSED, not absent", async () => {
    // One real bite in scope: under k=5, so the province cell must still be
    // there, marked suppressed with a null count — never a missing cell that
    // reads as "no bites here".
    const res = await loadMordedurassByUnit("province", GOVT, JURS, SINCE);
    const cell = res.cells.find((c) => c.province === PROVINCE);
    expect(cell).toBeDefined();
    expect(cell?.suppressed).toBe(true);
    expect(cell?.count).toBeNull();
  });
});

describe("the synthetic rows really are there — the exclusion is doing the work", () => {
  it("both animals exist in the jurisdiction, and only one is seed-tagged", async () => {
    const rows = await db
      .select({ token: pets.publicToken, seedTag: pets.seedTag })
      .from(pets)
      .where(eq(pets.jurisdictionLocality, LOCALITY));
    expect(rows.sort((a, b) => a.token.localeCompare(b.token))).toEqual([
      { token: REAL_TOKEN, seedTag: null },
      { token: SYNTH_TOKEN, seedTag: "panorama" },
    ]);
    const [caseCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(cases)
      .where(inArray(cases.id, [real.caseId, synth.caseId]));
    expect(caseCount.n).toBe(2);
  });
});
