// getLibretaFaceData — owner-path welfare-bridge event exclusion
// (pet-document-redesign privacy fix, REQ-1.2/1.3).
//
// Negative case: an owner viewer's Libreta pastEvents MUST NOT include a
// pet_events row bridged to an open welfare_denuncia case (maltreatment_
// reported / abandonment_reported), regardless of lens.
// Positive/regression case: a normal event (no caseId) and a
// symptom_observed event (legitimately sanitaria, no welfare caseId)
// remain visible.

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// getLibretaFaceData unconditionally calls lib/supabase/server's createClient
// to batch-sign attachment URLs. That helper reads next/headers `cookies()`,
// which throws outside a real Next.js request scope. None of this test's
// fixture events carry attachments, so a stub client (never actually used
// for signing) is sufficient — this keeps the test a real DB integration
// test (unlike sign-timeline-attachments.test.ts's fully mocked `db`).
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({}) as unknown,
}));

import { withMutationOverride } from "@/__tests__/_helpers/db-overrides";
import { type Pet, db, ownerships, pets } from "@/db";
import { openCase } from "@/lib/infra/case-helpers";
import { getLibretaFaceData } from "@/src/modules/pets/application/tab-data/get-libreta-face-data";

const PET_TOKEN = "DIM-PDR-S1-LIB1";

let petId: string;
let fixturePet: Pet;
let ownerUserId: string;
let welfareCaseId: string;
let welfareEventId: string;
let normalEventId: string;
let symptomEventId: string;

beforeAll(async () => {
  const [ownerProfile] = (await db.execute(sql`
    select p.id::text as id
    from public.profiles p
    join auth.users u on u.id = p.id
    where u.email = 'owner@dim.test'
    limit 1
  `)) as unknown as Array<{ id: string }>;
  if (!ownerProfile?.id) {
    throw new Error(
      "get-libreta-face-data test: owner@dim.test profile not found. Run `pnpm seed:test` first.",
    );
  }
  ownerUserId = ownerProfile.id;

  await withMutationOverride(async (tx) => {
    // FK-safe order: pet_events references BOTH cases (case_id) and pets, so it
    // must go FIRST — deleting cases first violates pet_events_case_id_cases_id_fk
    // whenever a previous run left a welfare event behind (the wedged-state
    // failure this cleanup exists to heal). Then ownerships → cases → pets.
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM ownerships WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`UPDATE cases SET welfare_report_id = NULL WHERE primary_pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`
      DELETE FROM cases WHERE primary_pet_id IN (
        SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
      )
    `);
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
  });

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "PDR S1 Libreta Pet",
      species: "dog",
      sex: "male",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId = pet.id;
  fixturePet = pet;

  await db.insert(ownerships).values({
    petId,
    ownerUserId,
    role: "owner",
  });

  const welfareCase = await openCase({
    kind: "welfare_denuncia",
    primarySubjectKind: "registered_pet",
    primaryPetId: petId,
    openedReason: {
      code: "welfare_report_citizen",
      referenceCode: "DEN-PDR-LIB",
      kind: "neglect",
      severity: "medium",
    },
  });
  welfareCaseId = welfareCase.id;

  const [welfareEvent] = await db
    .execute(
      sql`insert into public.pet_events (pet_id, event_type, occurred_at, case_id, author_role, payload)
          values (${petId}::uuid, 'maltreatment_reported', now(), ${welfareCaseId}::uuid, 'owner', '{}'::jsonb)
          returning id::text as id`,
    )
    .then((rows) => rows as unknown as Array<{ id: string }>);
  welfareEventId = welfareEvent.id;

  const [normalEvent] = await db
    .execute(
      sql`insert into public.pet_events (pet_id, event_type, occurred_at, author_role, payload)
          values (${petId}::uuid, 'vaccination_administered', now(), 'owner', '{}'::jsonb)
          returning id::text as id`,
    )
    .then((rows) => rows as unknown as Array<{ id: string }>);
  normalEventId = normalEvent.id;

  const [symptomEvent] = await db
    .execute(
      sql`insert into public.pet_events (pet_id, event_type, occurred_at, author_role, payload)
          values (${petId}::uuid, 'symptom_observed', now(), 'owner', '{}'::jsonb)
          returning id::text as id`,
    )
    .then((rows) => rows as unknown as Array<{ id: string }>);
  symptomEventId = symptomEvent.id;
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    // TOKEN-based (not id-based) + the same FK-safe order as the setup cleanup:
    // if beforeAll aborted mid-fixture, petId/welfareCaseId are undefined and an
    // id-based delete interpolates `= ::uuid` (a syntax error that masks the real
    // failure). The token form tears down whatever the setup got through.
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM ownerships WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`UPDATE cases SET welfare_report_id = NULL WHERE primary_pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
  });
});

describe("getLibretaFaceData — owner-path hidden-case event exclusion", () => {
  it("excludes the welfare-bridge maltreatment_reported event for the owner viewer", async () => {
    const result = await getLibretaFaceData({
      user: { id: ownerUserId },
      pet: fixturePet,
      accessPath: "owner",
      organization: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pastIds = result.data.past.map((e) => e.id);
    expect(pastIds).not.toContain(welfareEventId);
  });

  it("keeps the normal vaccination_administered event visible (regression)", async () => {
    const result = await getLibretaFaceData({
      user: { id: ownerUserId },
      pet: fixturePet,
      accessPath: "owner",
      organization: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pastIds = result.data.past.map((e) => e.id);
    expect(pastIds).toContain(normalEventId);
  });

  it("keeps symptom_observed visible — it is legitimately sanitaria, no welfare caseId", async () => {
    const result = await getLibretaFaceData({
      user: { id: ownerUserId },
      pet: fixturePet,
      accessPath: "owner",
      organization: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pastIds = result.data.past.map((e) => e.id);
    expect(pastIds).toContain(symptomEventId);
  });
});

// ---------------------------------------------------------------------------
// Pagination boundary (perf/scale review 2026-07-04 P0 — unbounded libreta
// event loads). The rendered `past` list is capped at PAST_EVENTS_WINDOW
// (250) most-recent events, but the vaccination summary reads a SEPARATE
// uncapped/type-narrow query, so a dose that falls OUTSIDE the rendered
// window must still be counted. These tests lock both halves of that boundary.
// ---------------------------------------------------------------------------

const PAGINATION_TOKEN = "DIM-PDR-S1-LIBPAGE";
// Mirror of the (unexported) PAST_EVENTS_WINDOW constant in the use-case.
const PAST_EVENTS_WINDOW = 250;
// Enough recent events to overflow the window and force truncation.
const RECENT_NOTE_COUNT = PAST_EVENTS_WINDOW + 30;

describe("getLibretaFaceData — pagination boundary (PAST_EVENTS_WINDOW)", () => {
  let pagePetId: string;
  let pagePet: Pet;
  let oldVaccinationEventId: string;

  beforeAll(async () => {
    await withMutationOverride(async (tx) => {
      await tx.execute(sql`DELETE FROM ownerships WHERE pet_id IN (
        SELECT id FROM pets WHERE public_token = ${PAGINATION_TOKEN}
      )`);
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
        SELECT id FROM pets WHERE public_token = ${PAGINATION_TOKEN}
      )`);
      await tx.execute(sql`DELETE FROM pets WHERE public_token = ${PAGINATION_TOKEN}`);
    });

    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: PAGINATION_TOKEN,
        name: "PDR S1 Libreta Pagination Pet",
        species: "dog",
        sex: "male",
        potentiallyDangerousBreed: false,
      })
      .returning();
    pagePetId = pet.id;
    pagePet = pet;

    await db.insert(ownerships).values({ petId: pagePetId, ownerUserId, role: "owner" });

    // 1) One OLD free-text vaccination, dated far in the past so it lands
    //    OUTSIDE the 250 most-recent window. Free-text (off-catalog) name so it
    //    lands in summary.otherCount — an unambiguous "the uncapped vaccination
    //    query saw it" signal.
    const [oldVax] = await db
      .execute(
        sql`insert into public.pet_events (pet_id, event_type, occurred_at, author_role, payload)
            values (
              ${pagePetId}::uuid,
              'vaccination_administered',
              now() - interval '10 years',
              'owner',
              ${sql.raw('\'{"vaccine_name": "BoundaryTestSerum XYZ"}\'::jsonb')}
            )
            returning id::text as id`,
      )
      .then((rows) => rows as unknown as Array<{ id: string }>);
    oldVaccinationEventId = oldVax.id;

    // 2) RECENT_NOTE_COUNT note_added events, each newer than the old vax and
    //    with strictly increasing occurred_at so DESC ordering is deterministic.
    await db.execute(sql`
      insert into public.pet_events (pet_id, event_type, occurred_at, author_role, payload)
      select
        ${pagePetId}::uuid,
        'note_added',
        now() - (make_interval(secs => (${RECENT_NOTE_COUNT} - g))),
        'owner',
        '{}'::jsonb
      from generate_series(1, ${RECENT_NOTE_COUNT}) as g
    `);
  });

  afterAll(async () => {
    await withMutationOverride(async (tx) => {
      // TOKEN-based for the same reason as the first describe's teardown: an
      // aborted setup leaves pagePetId undefined → `= ::uuid` syntax error.
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
        SELECT id FROM pets WHERE public_token = ${PAGINATION_TOKEN}
      )`);
      await tx.execute(sql`DELETE FROM ownerships WHERE pet_id IN (
        SELECT id FROM pets WHERE public_token = ${PAGINATION_TOKEN}
      )`);
      await tx.execute(sql`DELETE FROM pets WHERE public_token = ${PAGINATION_TOKEN}`);
    });
  });

  it("caps the rendered timeline at PAST_EVENTS_WINDOW and flags truncation", async () => {
    const result = await getLibretaFaceData({
      user: { id: ownerUserId },
      pet: pagePet,
      accessPath: "owner",
      organization: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.past.length).toBe(PAST_EVENTS_WINDOW);
    expect(result.data.pastTruncated).toBe(true);
    // The old vaccination is older than every note, so it is NOT in the window.
    const pastIds = result.data.past.map((e) => e.id);
    expect(pastIds).not.toContain(oldVaccinationEventId);
  });

  it("counts a vaccination that falls OUTSIDE the rendered window (summary is uncapped)", async () => {
    const result = await getLibretaFaceData({
      user: { id: ownerUserId },
      pet: pagePet,
      accessPath: "owner",
      organization: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The off-catalog dose is not rendered in `past`, yet the summary — read
    // from the separate uncapped query — still reflects it.
    expect(result.data.summary.otherCount).toBe(1);
  });
});
