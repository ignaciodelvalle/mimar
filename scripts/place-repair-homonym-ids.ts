#!/usr/bin/env tsx
/**
 * Repair (R7) — audit every place id a NAME-based backfill may have written
 * for a homonym, and re-derive it from the record itself.
 *
 * localidades-por-id B5. `scripts/backfill-locality-id.ts` (deleted in the same
 * work unit) filled `pets / welfare_reports / cases.locality_id` from the stored
 * (province, locality) NAME through `localityByName`, which settles a name two
 * municipalities share on the alphabetically first department: every Bragado
 * row named "Mechita" it touched now carries Alberti's id. Nothing reads those
 * ids yet; the day scope moves to ids (stage D) each one would move a pet, a
 * case or a denuncia to another municipality in silence.
 *
 * WHAT IT DOES. For every row whose stored pair names TWO OR MORE live
 * catalogue rows and that carries an id (the only rows the old script could
 * have got wrong), it finds what the RECORD says, never the name:
 *   - pets: the latest jurisdiction-bearing event (`pet_registered` or a
 *     jurisdiction move) — its `jurisdiction_locality_id` / `place.resolved` /
 *     `to_locality_id` (replayPetLocalityId, the same rule rederivePetCache
 *     uses);
 *   - cases: the earliest event of the case that carries `place`;
 *   - welfare_reports: the row's own `place_entered` (0248).
 * and decides (`decideRepair`):
 *   - the record agrees with the stored id → KEEP;
 *   - the record names another row, or says nothing resolved → REWRITE to it;
 *   - the record is silent → CLEAR the id (province-level, method
 *     `unresolved`, the unresolved queue of stage D9). The old id is never
 *     trusted as ground truth: it is exactly what is being audited.
 * Every write also appends a `place_resolutions` row (0250) saying what was
 * done and why — the repair is on the record, the event payloads are untouched.
 *
 * DRY RUN BY DEFAULT: prints the verdicts and writes nothing. `--apply` writes.
 * Migrations 0248-0251 must be applied first.
 *
 *   NODE_OPTIONS="--conditions=react-server" pnpm tsx scripts/place-repair-homonym-ids.ts
 *   NODE_OPTIONS="--conditions=react-server" pnpm tsx scripts/place-repair-homonym-ids.ts --apply
 *
 * `resolveBackfillPlace` is the entry point any future backfill of a
 * historical NAME uses: a pair gets an id only when it names exactly one row
 * (__tests__/place-backfill-never-guesses-homonym.test.ts holds it to that).
 */

import "./_load-env";

import { asc, eq, sql } from "drizzle-orm";

import { db, petEvents } from "@/db";
import type { PlaceMethod } from "@/lib/domain/place";
import { overlayAmendments } from "@/lib/infra/amendment";
import { resolveName } from "@/lib/place/resolve-place";
import { replayPetLocalityId } from "@/lib/projections/pet-jurisdiction";
import { provinceByCode, provinceByName } from "@/lib/reference/ar-provincias";

// ---------------------------------------------------------------------------
// The entry point for historical names
// ---------------------------------------------------------------------------

/**
 * The catalogue row a historical (province, locality) NAME pair may be given:
 * one only when the pair names exactly ONE live row of the province
 * (`legacy_unique_name`). A homonym, an unknown name or an unknown province is
 * `{ localityId: null }` — never one of the candidates.
 */
export async function resolveBackfillPlace(pair: {
  province: string;
  locality: string;
}): Promise<{ localityId: string | null; method: PlaceMethod }> {
  const province = provinceByCode(pair.province) ?? provinceByName(pair.province);
  if (!province || !pair.locality.trim()) return { localityId: null, method: "unresolved" };
  const place = await resolveName(province.code, pair.locality);
  return place.status === "resolved" && place.localityId
    ? { localityId: place.localityId, method: "legacy_unique_name" }
    : { localityId: null, method: "unresolved" };
}

// ---------------------------------------------------------------------------
// The decision, pure
// ---------------------------------------------------------------------------

export type RepairVerdict = "keep" | "rewrite" | "clear";

/**
 * What to do with one stored id.
 *
 * @param storedId  the id on the row today (possibly the old script's guess).
 * @param recorded  what the record says: a row id, `null` ("recorded that
 *   nothing resolved"), or `undefined` ("the record is silent").
 */
export function decideRepair(
  storedId: string | null,
  recorded: string | null | undefined,
): { verdict: RepairVerdict; localityId: string | null } {
  if (recorded === undefined) {
    return storedId === null
      ? { verdict: "keep", localityId: null }
      : { verdict: "clear", localityId: null };
  }
  if (recorded === storedId) return { verdict: "keep", localityId: storedId };
  return { verdict: "rewrite", localityId: recorded };
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

type Suspect = { id: string; locality_id: string };
type Table = "pets" | "cases" | "welfare_reports";

/** Rows with an id whose stored pair names two or more live catalogue rows. */
async function suspects(table: Table): Promise<Suspect[]> {
  return (await db.execute(sql`
    select t.id::text as id, t.locality_id::text as locality_id
      from ${sql.identifier(table)} t
     where t.locality_id is not null
       and t.jurisdiction_locality is not null
       and (select count(*) from public.ar_localities l
             where l.removed_at is null
               and l.province_code = public.ar_province_code(t.jurisdiction_province)
               and l.locality_name = t.jurisdiction_locality) > 1
     order by t.id
  `)) as unknown as Suspect[];
}

/**
 * pets: the latest jurisdiction-bearing event of each pet, by the projection's
 * own rule, over the amendment-overlaid stream (the same treatment
 * rederivePetCache gives it: a corrected place is the place).
 */
async function recordedForPets(ids: string[]): Promise<Map<string, string | null | undefined>> {
  const out = new Map<string, string | null | undefined>();
  for (const petId of ids) {
    const rows = await db
      .select({
        id: petEvents.id,
        eventType: petEvents.eventType,
        occurredAt: petEvents.occurredAt,
        recordedAt: petEvents.recordedAt,
        payload: petEvents.payload,
      })
      .from(petEvents)
      .where(eq(petEvents.petId, petId))
      .orderBy(asc(petEvents.occurredAt), asc(petEvents.recordedAt), asc(petEvents.id));
    const replay = replayPetLocalityId(overlayAmendments(rows));
    out.set(petId, replay === null ? undefined : replay.localityId);
  }
  return out;
}

/** cases: the earliest event of the case that carries `place`. */
async function recordedForCases(ids: string[]): Promise<Map<string, string | null | undefined>> {
  const out = new Map<string, string | null | undefined>();
  if (ids.length === 0) return out;
  const rows = (await db.execute(sql`
    select distinct on (e.case_id) e.case_id::text as case_id,
           e.payload->'place'->'resolved'->>'locality_id' as locality_id
      from public.pet_events e
     where e.case_id in (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
       and e.payload ? 'place'
     order by e.case_id, e.occurred_at, e.recorded_at, e.id
  `)) as unknown as Array<{ case_id: string; locality_id: string | null }>;
  for (const r of rows) out.set(r.case_id, r.locality_id);
  return out;
}

/** welfare_reports: the row's own place as entered/resolved (0248). */
async function recordedForWelfare(ids: string[]): Promise<Map<string, string | null | undefined>> {
  const out = new Map<string, string | null | undefined>();
  if (ids.length === 0) return out;
  const rows = (await db.execute(sql`
    select w.id::text as id, w.place_entered->'resolved'->>'locality_id' as locality_id
      from public.welfare_reports w
     where w.id in (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
       and w.place_entered is not null
  `)) as unknown as Array<{ id: string; locality_id: string | null }>;
  for (const r of rows) out.set(r.id, r.locality_id);
  return out;
}

const RECORDED: Record<Table, (ids: string[]) => Promise<Map<string, string | null | undefined>>> =
  {
    pets: recordedForPets,
    cases: recordedForCases,
    welfare_reports: recordedForWelfare,
  };

async function audit(table: Table, apply: boolean): Promise<Record<RepairVerdict, number>> {
  const rows = await suspects(table);
  const recorded = await RECORDED[table](rows.map((r) => r.id));
  const tally: Record<RepairVerdict, number> = { keep: 0, rewrite: 0, clear: 0 };

  for (const row of rows) {
    const decision = decideRepair(row.locality_id, recorded.get(row.id));
    tally[decision.verdict]++;
    if (decision.verdict === "keep") continue;
    console.log(
      `  ${table} ${row.id}: ${decision.verdict} ${row.locality_id} -> ${decision.localityId ?? "NULL"}`,
    );
    if (!apply) continue;

    const method: PlaceMethod = decision.localityId === null ? "unresolved" : "spine_rederived";
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        update ${sql.identifier(table)}
           set locality_id = ${decision.localityId}::uuid, place_method = ${method}
         where id = ${row.id}::uuid
      `);
      await tx.execute(sql`
        insert into public.place_resolutions (subject_table, subject_id, locality_id, method, reason)
        values (${table}, ${row.id}::uuid, ${decision.localityId}::uuid, ${method},
                ${`R7 repair (${decision.verdict}): the stored id ${row.locality_id} was written from a homonym name`})
      `);
    });
  }
  return tally;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(`[place-repair-homonym-ids] ${apply ? "APPLY" : "dry run (no writes)"}`);
  for (const table of ["pets", "cases", "welfare_reports"] as const) {
    console.log(`\n── ${table} ──`);
    const tally = await audit(table, apply);
    console.log(
      `  homonym-named rows with an id: keep ${tally.keep}, rewrite ${tally.rewrite}, clear ${tally.clear}`,
    );
  }
  console.log("\n[place-repair-homonym-ids] done.");
}

if (process.argv[1]?.endsWith("place-repair-homonym-ids.ts")) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[place-repair-homonym-ids] fatal error:", err);
      process.exit(1);
    });
}
