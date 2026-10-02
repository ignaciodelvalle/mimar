// Migration 0275 recovers a case's catalogue id only where nothing is guessed
// (localidades CABA + Córdoba, 2026-10, change C2).
//
// Run against the local catalogue, inside ONE transaction that always rolls
// back (the local database is shared by every worktree; the migration body is
// executed there, so nothing it touches outlives the test):
//   - a case a writer files at the pet's HOME by construction takes the pet's
//     own id — even on a homonym, because the pet already says which twin;
//   - a lost case on the same homonym does NOT: a lost report can be filed
//     where the animal went missing, and the same name there may be the
//     other twin;
//   - a home case whose pet moved after the case opened does NOT either;
//   - a unique name gets its row (0251's rule) — the CABA lost cases;
//   - a row a writer declared `unresolved` is left alone;
//   - a second run changes nothing.
//
// KNOWN EDGE, accepted (review 2026-10-02): the "moved after the case opened"
// guard reads `movement_recorded.recorded_at` only. A move recorded BEFORE the
// case opened and AMENDED after it (event_amended — movement_recorded is
// amendable) is not seen, so such a case can take the pet's current id. It is
// noted here and not in the migration's own header because 0275 is already
// applied to the local databases, and scripts/migrate.ts treats a checksum
// change on an applied file as fatal drift.

import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { pets } from "@/db";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { CasesRepository } from "@/src/modules/cases/infrastructure/cases-repository";

import { type Tx, inRolledBackTx, insertEvent, rows, seedUser } from "./_helpers/erasure-tx";

const MIGRATION = readFileSync("db/migrations/0275_place_backfill_unambiguous_again.sql", "utf8");
const repo = new CasesRepository();

type Place = { id: string; province: string; locality: string };

async function homonymTwins(tx: Tx): Promise<[Place, Place]> {
  const found = await rows(
    tx,
    sql`select l.id::text as id, public.ar_province_name(l.province_code) as province,
               l.locality_name as locality
          from public.ar_localities l
         where l.removed_at is null
           and (l.province_code, l.locality_name) = (
             select province_code, locality_name from public.ar_localities
              where removed_at is null
              group by province_code, locality_name
             having count(*) = 2
              order by (province_code = 'AR-X') desc, province_code, locality_name
              limit 1)
         order by l.id`,
  );
  // Non-vacuity: the local catalogue carries homonyms (Córdoba has seven pairs).
  expect(found).toHaveLength(2);
  return found as unknown as [Place, Place];
}

async function uniquePlace(tx: Tx): Promise<Place> {
  const [row] = await rows(
    tx,
    sql`select min(l.id::text) as id, public.ar_province_name(l.province_code) as province,
               l.locality_name as locality
          from public.ar_localities l
         where l.removed_at is null
         group by l.province_code, l.locality_name
        having count(*) = 1
         order by (l.province_code = 'AR-C' and l.locality_name = 'Palermo') desc,
                  l.province_code, l.locality_name
         limit 1`,
  );
  expect(row).toBeDefined();
  return row as unknown as Place;
}

async function seedHomePet(tx: Tx, home: Place): Promise<{ id: string; token: string }> {
  const token = generatePublicToken();
  const [pet] = await tx
    .insert(pets)
    .values({
      publicToken: token,
      name: "Backfill0275",
      species: "dog",
      sex: "female",
      potentiallyDangerousBreed: false,
      jurisdictionProvince: home.province,
      jurisdictionLocality: home.locality,
      localityId: home.id,
    })
    .returning({ id: pets.id });
  return { id: pet.id, token };
}

async function caseRow(tx: Tx, id: string) {
  const [row] = await rows(
    tx,
    sql`select locality_id::text as "localityId", place_method as "placeMethod"
          from public.cases where id = ${id}::uuid`,
  );
  return row;
}

describe("migration 0275 — recover a case's catalogue id without guessing", () => {
  it("fills what can be filled honestly and leaves every guess NULL", async () => {
    const seen = await inRolledBackTx(async (tx) => {
      const [twinA] = await homonymTwins(tx);
      const unique = await uniquePlace(tx);
      const userId = await seedUser(tx, "backfill-0275");

      const homePet = await seedHomePet(tx, twinA);
      const movedPet = await seedHomePet(tx, twinA);
      const uniquePet = await seedHomePet(tx, unique);
      const unresolvedPet = await seedHomePet(tx, unique);

      // Old writers: the pair, no id (the bug this work unit fixes).
      const pair = (p: Place) => ({
        jurisdictionProvince: p.province,
        jurisdictionLocality: p.locality,
      });
      const fosterHome = await repo.openCase(
        {
          kind: "foster_placement",
          primarySubjectKind: "registered_pet",
          primaryPetId: homePet.id,
          ...pair(twinA),
          openedByUserId: userId,
          openedReason: {
            code: "foster_placement_assigned",
            actorOrgDisplayName: "Refugio 0275",
            expectedWeeks: null,
          },
        },
        tx,
      );
      const lostHomonym = await repo.openCase(
        {
          kind: "lost_pet_episode",
          primarySubjectKind: "registered_pet",
          primaryPetId: homePet.id,
          ...pair(twinA),
          openedByUserId: userId,
          openedReason: { code: "pet_marked_lost", petPublicToken: homePet.token, ownerNote: null },
        },
        tx,
      );
      const fosterMoved = await repo.openCase(
        {
          kind: "foster_proposal",
          primarySubjectKind: "registered_pet",
          primaryPetId: movedPet.id,
          ...pair(twinA),
          openedByUserId: userId,
          openedReason: { code: "foster_proposal_sent" },
        },
        tx,
      );
      // The move is recorded AFTER the case opened — both instants from the
      // database (the case's own opened_at), never the host clock.
      await insertEvent(tx, {
        petId: movedPet.id,
        eventType: "movement_recorded",
        recordedByUserId: userId,
        authorRole: "owner",
        payload: {},
        extra: { recordedAt: new Date(fosterMoved.openedAt.getTime() + 60_000) },
      });
      const lostUnique = await repo.openCase(
        {
          kind: "lost_pet_episode",
          primarySubjectKind: "registered_pet",
          primaryPetId: uniquePet.id,
          ...pair(unique),
          openedByUserId: userId,
          openedReason: {
            code: "pet_marked_lost",
            petPublicToken: uniquePet.token,
            ownerNote: null,
          },
        },
        tx,
      );
      const declaredUnresolved = await repo.openCase(
        {
          kind: "lost_pet_episode",
          primarySubjectKind: "registered_pet",
          primaryPetId: unresolvedPet.id,
          ...pair(unique),
          placeMethod: "unresolved",
          openedByUserId: userId,
          openedReason: {
            code: "pet_marked_lost",
            petPublicToken: unresolvedPet.token,
            ownerNote: null,
          },
        },
        tx,
      );

      await tx.execute(sql.raw(MIGRATION));
      const first = {
        fosterHome: await caseRow(tx, fosterHome.id),
        lostHomonym: await caseRow(tx, lostHomonym.id),
        fosterMoved: await caseRow(tx, fosterMoved.id),
        lostUnique: await caseRow(tx, lostUnique.id),
        declaredUnresolved: await caseRow(tx, declaredUnresolved.id),
      };
      await tx.execute(sql.raw(MIGRATION));
      const second = {
        fosterHome: await caseRow(tx, fosterHome.id),
        lostHomonym: await caseRow(tx, lostHomonym.id),
        fosterMoved: await caseRow(tx, fosterMoved.id),
        lostUnique: await caseRow(tx, lostUnique.id),
        declaredUnresolved: await caseRow(tx, declaredUnresolved.id),
      };
      return { first, second, twinA, unique };
    });

    expect(seen.first).toEqual({
      fosterHome: { localityId: seen.twinA.id, placeMethod: "spine_rederived" },
      lostHomonym: { localityId: null, placeMethod: null },
      fosterMoved: { localityId: null, placeMethod: null },
      lostUnique: { localityId: seen.unique.id, placeMethod: "legacy_unique_name" },
      declaredUnresolved: { localityId: null, placeMethod: "unresolved" },
    });
    // Idempotent: a re-run changes nothing.
    expect(seen.second).toEqual(seen.first);
  });
});
