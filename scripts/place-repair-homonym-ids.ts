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
 * catalogue rows, that carries an id, and whose `place_method` is NULL (a row
 * whose method is recorded was written by a writer that knew how it resolved,
 * never by the old script), it finds what the RECORD says, never the name:
 *   - pets: the latest jurisdiction-bearing event (`pet_registered` or a
 *     jurisdiction move) — its `jurisdiction_locality_id` / `place.resolved` /
 *     `to_locality_id` (replayPetLocalityId, the same rule rederivePetCache
 *     uses);
 *   - cases: the earliest event of the case that carries `place`;
 *   - welfare_reports: the row's own `place_entered` (0248), else the `place`
 *     of the event it bridged to (`payload.welfare_report_id`).
 * and decides (`decideRepair`):
 *   - the record agrees with the stored id → KEEP;
 *   - the record names another row, or says nothing resolved → REWRITE to it;
 *   - the record is SILENT → that is not evidence: the sources did not exist
 *     before stage A/B1, so every older row is silent by construction
 *     (security review of stage B). The id is CLEARED only when it is the old
 *     script's own fingerprint — the row `resolveCanonicalJurisdiction` settles
 *     the homonym on (the alphabetically first department). Any other id (a
 *     pin that picked Bragado's Mechita) is KEPT, marked unproven.
 * Every change first appends a pre-image (`place_repair_preimages`, 0251:
 * table, row, old id, new id, verdict, reason, run), then moves the row, then
 * appends a `place_resolutions` row (0250). Event payloads are never touched.
 *
 * DRY RUN BY DEFAULT: prints the target database and the verdicts, writes
 * nothing. `--apply` writes — on a non-local database only together with
 * `--i-reviewed-dry-run=<n>`, where <n> is the change count the dry run printed
 * for that same database. Migrations 0248-0251 must be applied first.
 *
 *   NODE_OPTIONS="--conditions=react-server" pnpm tsx scripts/place-repair-homonym-ids.ts
 *   NODE_OPTIONS="--conditions=react-server" pnpm tsx scripts/place-repair-homonym-ids.ts --apply
 *
 * `resolveBackfillPlace` is the entry point any future backfill of a
 * historical NAME uses: a pair gets an id only when it names exactly one row
 * (__tests__/place-backfill-never-guesses-homonym.test.ts holds it to that).
 * The safeguards are pinned in __tests__/place-repair-homonym-ids.test.ts.
 */

import "./_load-env";

import { asc, eq, sql } from "drizzle-orm";

import { db, petEvents } from "@/db";
import type { PlaceMethod } from "@/lib/domain/place";
import { overlayAmendments } from "@/lib/infra/amendment";
import { resolveCanonicalJurisdiction } from "@/lib/infra/jurisdiction-validation";
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

export type RepairVerdict = "keep" | "keep_unproven" | "rewrite" | "clear";

/**
 * What to do with one stored id.
 *
 * @param storedId    the id on the row today (possibly the old script's guess).
 * @param recorded    what the record says: a row id, `null` ("recorded that
 *   nothing resolved"), or `undefined` ("the record is silent").
 * @param fingerprint the row the deleted name resolver picks for the row's
 *   pair — what the old script would have written; `null` when it picks none.
 */
export function decideRepair(
  storedId: string | null,
  recorded: string | null | undefined,
  fingerprint: string | null,
): { verdict: RepairVerdict; localityId: string | null } {
  if (recorded !== undefined) {
    return recorded === storedId
      ? { verdict: "keep", localityId: storedId }
      : { verdict: "rewrite", localityId: recorded };
  }
  if (storedId !== null && storedId === fingerprint) return { verdict: "clear", localityId: null };
  return { verdict: "keep_unproven", localityId: storedId };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Refuse `--apply` on a non-local database unless the reviewed count matches. */
export function assertApplyAllowed(input: {
  host: string;
  reviewedCount: number | null;
  plannedCount: number;
}): void {
  if (LOCAL_HOSTS.has(input.host)) return;
  if (input.reviewedCount === null) {
    throw new Error(
      `refusing --apply on ${input.host}: run the dry run first and pass --i-reviewed-dry-run=${input.plannedCount}`,
    );
  }
  if (input.reviewedCount !== input.plannedCount) {
    throw new Error(
      `refusing --apply on ${input.host}: you reviewed ${input.reviewedCount} change(s), this run plans ${input.plannedCount}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

type Executor = Pick<typeof db, "execute" | "select">;
type Table = "pets" | "cases" | "welfare_reports";
type Recorded = Map<string, string | null | undefined>;

export type RepairDecision = {
  table: Table;
  id: string;
  storedId: string;
  verdict: RepairVerdict;
  localityId: string | null;
  reason: string;
};

type Suspect = { id: string; locality_id: string; province: string; locality: string };

/**
 * Rows the old script could have written: an id, no recorded method (a
 * recorded one means a writer that knew how it resolved), and a stored pair
 * naming two or more rows.
 */
async function suspects(executor: Executor, table: Table): Promise<Suspect[]> {
  return (await executor.execute(sql`
    select t.id::text as id, t.locality_id::text as locality_id,
           t.jurisdiction_province as province, t.jurisdiction_locality as locality
      from ${sql.identifier(table)} t
     where t.locality_id is not null
       and t.place_method is null
       and t.jurisdiction_locality is not null
       and (select count(*) from public.ar_localities l
             where l.removed_at is null
               and l.province_code = public.ar_province_code(t.jurisdiction_province)
               and l.locality_name = t.jurisdiction_locality) > 1
     order by t.id
  `)) as unknown as Suspect[];
}

/**
 * The row the DELETED name backfill would have written for this pair — the R7
 * fingerprint. It is called here on purpose (lint:place-resolver freezes this
 * one caller): the repair must reproduce the old guess to recognise it.
 */
async function fingerprintOf(province: string, locality: string): Promise<string | null> {
  try {
    const canonical = await resolveCanonicalJurisdiction({
      rawProvince: province,
      rawLocality: locality,
    });
    return canonical.locality.id;
  } catch {
    return null;
  }
}

function uuidList(ids: string[]) {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

/**
 * pets: the latest jurisdiction-bearing event of each pet, by the projection's
 * own rule, over the amendment-overlaid stream (the same treatment
 * rederivePetCache gives it: a corrected place is the place).
 */
async function recordedForPets(executor: Executor, ids: string[]): Promise<Recorded> {
  const out: Recorded = new Map();
  for (const petId of ids) {
    const rows = await executor
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
async function recordedForCases(executor: Executor, ids: string[]): Promise<Recorded> {
  const out: Recorded = new Map();
  if (ids.length === 0) return out;
  const rows = (await executor.execute(sql`
    select distinct on (e.case_id) e.case_id::text as case_id,
           e.payload->'place'->'resolved'->>'locality_id' as locality_id
      from public.pet_events e
     where e.case_id in (${uuidList(ids)})
       and e.payload ? 'place'
     order by e.case_id, e.occurred_at, e.recorded_at, e.id
  `)) as unknown as Array<{ case_id: string; locality_id: string | null }>;
  for (const r of rows) out.set(r.case_id, r.locality_id);
  return out;
}

/**
 * welfare_reports: the row's own place as entered/resolved (0248); else the
 * `place` of the earliest event it bridged to (`payload.welfare_report_id`).
 */
async function recordedForWelfare(executor: Executor, ids: string[]): Promise<Recorded> {
  const out: Recorded = new Map();
  if (ids.length === 0) return out;
  const own = (await executor.execute(sql`
    select w.id::text as id, w.place_entered->'resolved'->>'locality_id' as locality_id
      from public.welfare_reports w
     where w.id in (${uuidList(ids)})
       and w.place_entered is not null
  `)) as unknown as Array<{ id: string; locality_id: string | null }>;
  for (const r of own) out.set(r.id, r.locality_id);

  const silent = ids.filter((id) => !out.has(id));
  if (silent.length === 0) return out;
  const bridged = (await executor.execute(sql`
    select distinct on (e.payload->>'welfare_report_id')
           e.payload->>'welfare_report_id' as id,
           e.payload->'place'->'resolved'->>'locality_id' as locality_id
      from public.pet_events e
     where e.payload->>'welfare_report_id' in (${sql.join(
       silent.map((id) => sql`${id}`),
       sql`, `,
     )})
       and e.payload ? 'place'
     order by e.payload->>'welfare_report_id', e.occurred_at, e.recorded_at, e.id
  `)) as unknown as Array<{ id: string; locality_id: string | null }>;
  for (const r of bridged) out.set(r.id, r.locality_id);
  return out;
}

const RECORDED: Record<Table, (executor: Executor, ids: string[]) => Promise<Recorded>> = {
  pets: recordedForPets,
  cases: recordedForCases,
  welfare_reports: recordedForWelfare,
};

function reasonFor(verdict: RepairVerdict, said: string | null | undefined): string {
  if (said !== undefined) return `R7 repair (${verdict}): the record names ${said ?? "no row"}`;
  return verdict === "clear"
    ? "R7 repair (clear): no record names the row, and the stored id is the name backfill's first-department pick"
    : "R7 repair (keep_unproven): no record names the row, and the stored id is not the name backfill's pick";
}

/** Every suspect row of `table` with its verdict. Reads only. */
export async function planRepair(executor: Executor, table: Table): Promise<RepairDecision[]> {
  const rows = await suspects(executor, table);
  const recorded = await RECORDED[table](
    executor,
    rows.map((r) => r.id),
  );
  const fingerprints = new Map<string, string | null>();
  const decisions: RepairDecision[] = [];
  for (const row of rows) {
    const key = JSON.stringify([row.province, row.locality]);
    if (!fingerprints.has(key)) {
      fingerprints.set(key, await fingerprintOf(row.province, row.locality));
    }
    const said = recorded.get(row.id);
    const decision = decideRepair(row.locality_id, said, fingerprints.get(key) ?? null);
    decisions.push({
      table,
      id: row.id,
      storedId: row.locality_id,
      ...decision,
      reason: reasonFor(decision.verdict, said),
    });
  }
  return decisions;
}

/** One change: the pre-image first, then the row, then the resolution record. */
export async function applyRepair(
  executor: Executor,
  runId: string,
  decision: RepairDecision,
): Promise<void> {
  if (decision.verdict !== "rewrite" && decision.verdict !== "clear") return;
  const method: PlaceMethod = decision.localityId === null ? "unresolved" : "spine_rederived";
  await executor.execute(sql`
    insert into public.place_repair_preimages
      (run_id, subject_table, subject_id, old_locality_id, new_locality_id, verdict, reason)
    values (${runId}::uuid, ${decision.table}, ${decision.id}::uuid, ${decision.storedId}::uuid,
            ${decision.localityId}::uuid, ${decision.verdict}, ${decision.reason})
  `);
  await executor.execute(sql`
    update ${sql.identifier(decision.table)}
       set locality_id = ${decision.localityId}::uuid, place_method = ${method}
     where id = ${decision.id}::uuid
  `);
  await executor.execute(sql`
    insert into public.place_resolutions (subject_table, subject_id, locality_id, method, reason)
    values (${decision.table}, ${decision.id}::uuid, ${decision.localityId}::uuid, ${method},
            ${decision.reason})
  `);
}

function targetHost(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? "").hostname;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const reviewedArg = process.argv.find((a) => a.startsWith("--i-reviewed-dry-run="));
  const reviewedCount = reviewedArg
    ? Number(reviewedArg.slice(reviewedArg.indexOf("=") + 1))
    : null;
  const host = targetHost();
  console.log(`[place-repair-homonym-ids] target database host: ${host}`);
  console.log(`[place-repair-homonym-ids] ${apply ? "APPLY" : "dry run (no writes)"}`);

  const plan: RepairDecision[] = [];
  for (const table of ["pets", "cases", "welfare_reports"] as const) {
    const decisions = await planRepair(db, table);
    plan.push(...decisions);
    const tally: Record<RepairVerdict, number> = {
      keep: 0,
      keep_unproven: 0,
      rewrite: 0,
      clear: 0,
    };
    for (const d of decisions) {
      tally[d.verdict]++;
      if (d.verdict === "rewrite" || d.verdict === "clear") {
        console.log(`  ${table} ${d.id}: ${d.verdict} ${d.storedId} -> ${d.localityId ?? "NULL"}`);
      }
    }
    console.log(
      `── ${table} ── keep ${tally.keep}, keep_unproven ${tally.keep_unproven}, rewrite ${tally.rewrite}, clear ${tally.clear}`,
    );
  }
  const changes = plan.filter((d) => d.verdict === "rewrite" || d.verdict === "clear");
  console.log(`[place-repair-homonym-ids] changes planned: ${changes.length}`);
  if (!apply) return;

  assertApplyAllowed({ host, reviewedCount, plannedCount: changes.length });
  const runId = crypto.randomUUID();
  for (const decision of changes) {
    await db.transaction(async (tx) => applyRepair(tx, runId, decision));
  }
  console.log(`[place-repair-homonym-ids] applied ${changes.length} change(s), run ${runId}.`);
}

if (process.argv[1]?.endsWith("place-repair-homonym-ids.ts")) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[place-repair-homonym-ids] fatal error:", err);
      process.exit(1);
    });
}
