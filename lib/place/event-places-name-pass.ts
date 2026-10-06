// The name pass over UNRESOLVED event_places rows — PO decision 2026-10-06.
//
// Reads every unresolved row's `entered` name (lib/place/event-place-names.ts),
// asks THE resolver once per distinct (province, name) pair (resolveName: one
// live row of the province, or nothing — never the first homonym), and, in
// apply mode, writes the catalogue id ONLY on rows whose pair names exactly
// one row, with method `legacy_unique_name` (0251 / 0275 rule B's word for
// "the id came from a unique historical name"). Ambiguous and unknown names
// are never touched: they stay province-level for a person.
//
// event_places is a declared projection (0250): the events are never touched
// (P2). Each batch is its own transaction of at most APPLY_BATCH rows (the
// staging session pooler closed a 500-row transaction), and every UPDATE
// re-checks `method = 'unresolved' AND locality_id IS NULL` and that the row
// is still live in the catalogue, so a re-run, or a run resumed after a
// failure, writes only what is still missing.
//
// Executor-first, so a test can run it inside a rolled-back transaction (each
// batch is then a savepoint). The operator door is
// scripts/place-resolve-event-places-by-name.ts.

import { sql } from "drizzle-orm";

import type { db } from "@/db";
import {
  type ClassifiedPair,
  type EnteredShape,
  type Projection,
  extractEnteredName,
  project,
  unaskable,
  verdictOf,
} from "@/lib/place/event-place-names";
import { resolveName } from "@/lib/place/resolve-place";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type NamePassExecutor = typeof db | Tx;

/** Rows per write transaction. The staging pooler closed one at 500. */
export const APPLY_BATCH = 50;
/** Rows per read page. */
const READ_PAGE = 5000;

export type NamePassScope = {
  /** Restrict the pass to these pets (tests). Absent = the whole table. */
  petIds?: readonly string[];
};

/**
 * How each read reaches the database. The default runs it on the executor; the
 * operator's dry run wraps EACH read in its own short READ ONLY transaction
 * (the database refuses a write there, and no transaction stays open long
 * enough for the pooler to close it).
 */
export type ReadRunner = <T>(read: (exec: NamePassExecutor) => Promise<T>) => Promise<T>;

/** Progress lines for the operator; silent by default. */
export type NamePassLog = (line: string) => void;

type UnresolvedRow = { eventId: string; provinceCode: string | null; entered: unknown };

export type KeyShape = { keys: string; source: string | null; rows: number };

export type SpineSourceShape = {
  eventType: string;
  /** Payload keys of the spine event that hold the home, as present/absent flags. */
  keys: string;
  spineEvents: number;
  rows: number;
};

export type NamePassInventory = {
  before: { resolved: number; unresolved: number };
  enteredKeyShapes: KeyShape[];
  spineSources: SpineSourceShape[];
  rowsByShape: Record<EnteredShape, number>;
  pairs: ClassifiedPair[];
  /** Unique pairs by how the resolver matched (exact catalogue spelling or folded). */
  uniqueBy: { exact_name_unique: number; folded_name_unique: number };
  projection: Projection;
  /** event ids per unique pair key — what apply writes. */
  uniqueTargets: Map<string, { localityId: string; provinceCode: string; eventIds: string[] }>;
};

function pairKey(code: string | null, locality: string | null): string {
  return `${code ?? ""}\u0000${locality ?? ""}`;
}

function scopeClause(scope: NamePassScope) {
  if (!scope.petIds) return sql``;
  if (scope.petIds.length === 0) return sql` and false`;
  return sql` and p.pet_id in (${sql.join(
    scope.petIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

async function counts(exec: NamePassExecutor, scope: NamePassScope) {
  const [row] = (await exec.execute(sql`
    select count(*) filter (where p.method = 'unresolved')::int as unresolved,
           count(*) filter (where p.method <> 'unresolved')::int as resolved
      from public.event_places p
     where true ${scopeClause(scope)}
  `)) as unknown as Array<{ unresolved: number; resolved: number }>;
  return { resolved: Number(row?.resolved ?? 0), unresolved: Number(row?.unresolved ?? 0) };
}

async function enteredKeyShapes(exec: NamePassExecutor, scope: NamePassScope): Promise<KeyShape[]> {
  const rows = (await exec.execute(sql`
    select coalesce((select string_agg(k, ',' order by k) from jsonb_object_keys(p.entered) k), '')
             as keys,
           p.entered ->> 'source' as source,
           count(*)::int as rows
      from public.event_places p
     where p.method = 'unresolved' ${scopeClause(scope)}
     group by 1, 2
     order by 3 desc
  `)) as unknown as Array<{ keys: string; source: string | null; rows: number }>;
  return rows.map((r) => ({ keys: r.keys, source: r.source, rows: Number(r.rows) }));
}

/** Which payload keys the spine events behind the spine-shaped rows carry. */
async function spineSources(
  exec: NamePassExecutor,
  scope: NamePassScope,
): Promise<SpineSourceShape[]> {
  const rows = (await exec.execute(sql`
    select s.event_type as "eventType",
           concat_ws(',',
             case when s.payload ? 'jurisdiction_province' then 'jurisdiction_province' end,
             case when s.payload ? 'jurisdiction_locality' then 'jurisdiction_locality' end,
             case when s.payload ? 'jurisdiction_locality_id'
                  then 'jurisdiction_locality_id'
                       || case when s.payload ->> 'jurisdiction_locality_id' is null
                               then '(null)' else '' end end,
             case when s.payload ? 'place' then 'place' end,
             case when s.payload ? 'to_province' then 'to_province' end,
             case when s.payload ? 'to_locality' then 'to_locality' end,
             case when s.payload ? 'to_locality_id'
                  then 'to_locality_id'
                       || case when s.payload ->> 'to_locality_id' is null
                               then '(null)' else '' end end
           ) as keys,
           count(distinct s.id)::int as "spineEvents",
           count(*)::int as rows
      from public.event_places p
      join public.pet_events s on s.id = (p.entered ->> 'spine_event_id')::uuid
     where p.method = 'unresolved'
       and p.entered ->> 'source' = 'spine' ${scopeClause(scope)}
     group by 1, 2
     order by 4 desc
  `)) as unknown as SpineSourceShape[];
  return rows.map((r) => ({ ...r, spineEvents: Number(r.spineEvents), rows: Number(r.rows) }));
}

async function unresolvedRows(run: ReadRunner, scope: NamePassScope): Promise<UnresolvedRow[]> {
  const out: UnresolvedRow[] = [];
  let after: string | null = null;
  for (;;) {
    const cursor: string | null = after;
    const page: UnresolvedRow[] = await run(
      async (exec): Promise<UnresolvedRow[]> =>
        (await exec.execute(sql`
      select p.event_id::text as "eventId", p.province_code as "provinceCode", p.entered
        from public.event_places p
       where p.method = 'unresolved'
         and (${cursor}::uuid is null or p.event_id > ${cursor}::uuid)
         ${scopeClause(scope)}
       order by p.event_id
       limit ${READ_PAGE}
    `)) as unknown as UnresolvedRow[],
    );
    out.push(...page);
    if (page.length < READ_PAGE) break;
    after = page[page.length - 1]?.eventId ?? null;
  }
  return out;
}

/**
 * Everything the dry run prints, and the targets apply writes. Reads only:
 * the rows through `exec` (each read via `opts.run`), the catalogue through
 * the resolver.
 */
export async function inventoryNamePass(
  exec: NamePassExecutor,
  scope: NamePassScope = {},
  opts: { run?: ReadRunner; log?: NamePassLog } = {},
): Promise<NamePassInventory> {
  const run: ReadRunner = opts.run ?? ((read) => read(exec));
  const log: NamePassLog = opts.log ?? (() => {});
  const t0 = Date.now();
  const lap = (what: string) => log(`  ${what} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  const before = await run((e) => counts(e, scope));
  lap("counted");
  const keyShapes = await run((e) => enteredKeyShapes(e, scope));
  lap("entered key shapes read");
  const sources = await run((e) => spineSources(e, scope));
  lap("spine source shapes read");
  const rows = await unresolvedRows(run, scope);
  lap(`unresolved rows read: ${rows.length}`);

  const rowsByShape: Record<EnteredShape, number> = { spine: 0, event_place: 0, unknown: 0 };
  const groups = new Map<
    string,
    {
      provinceCode: string | null;
      enteredProvince: string | null;
      locality: string | null;
      eventIds: string[];
    }
  >();
  for (const r of rows) {
    const name = extractEnteredName(r.entered, r.provinceCode);
    rowsByShape[name.shape] += 1;
    const key = pairKey(name.provinceCode, name.locality);
    const g = groups.get(key) ?? {
      provinceCode: name.provinceCode,
      enteredProvince: name.enteredProvince,
      locality: name.locality,
      eventIds: [],
    };
    g.eventIds.push(r.eventId);
    groups.set(key, g);
  }

  const pairs: ClassifiedPair[] = [];
  const uniqueBy = { exact_name_unique: 0, folded_name_unique: 0 };
  const uniqueTargets: NamePassInventory["uniqueTargets"] = new Map();
  for (const [key, g] of groups) {
    const base = {
      provinceCode: g.provinceCode,
      enteredProvince: g.enteredProvince,
      locality: g.locality,
      rows: g.eventIds.length,
    };
    const missing = unaskable(g);
    if (missing) {
      pairs.push({ ...base, verdict: "none", localityId: null, noneReason: missing });
      continue;
    }
    const answer = await resolveName(g.provinceCode as string, g.locality as string);
    const verdict = verdictOf(answer);
    if (verdict === "unique" && answer.localityId && answer.provinceCode) {
      if (answer.method === "exact_name_unique") uniqueBy.exact_name_unique += 1;
      else uniqueBy.folded_name_unique += 1;
      pairs.push({ ...base, verdict, localityId: answer.localityId, noneReason: null });
      uniqueTargets.set(key, {
        localityId: answer.localityId,
        provinceCode: answer.provinceCode,
        eventIds: g.eventIds,
      });
    } else if (verdict === "ambiguous") {
      pairs.push({ ...base, verdict, localityId: null, noneReason: null });
    } else {
      const noneReason = answer.reason === "none_entered" ? "unknown_province" : "not_in_catalogue";
      pairs.push({ ...base, verdict: "none", localityId: null, noneReason });
    }
  }
  lap(`pairs asked of the resolver: ${groups.size}`);

  return {
    before,
    enteredKeyShapes: keyShapes,
    spineSources: sources,
    rowsByShape,
    pairs,
    uniqueBy,
    projection: project(pairs, before),
    uniqueTargets,
  };
}

export type ApplyResult = { batches: number; updated: number; skipped: number };

/**
 * Write the unique targets, APPLY_BATCH rows per transaction. A row that is no
 * longer unresolved (an earlier run, the admin queue), or whose catalogue row
 * was removed meanwhile, is skipped, not overwritten.
 */
export async function applyNamePass(
  exec: NamePassExecutor,
  inventory: Pick<NamePassInventory, "uniqueTargets">,
  onBatch?: (done: ApplyResult) => void,
): Promise<ApplyResult> {
  const result: ApplyResult = { batches: 0, updated: 0, skipped: 0 };
  const work: Array<{ eventId: string; localityId: string; provinceCode: string }> = [];
  for (const t of inventory.uniqueTargets.values()) {
    for (const eventId of t.eventIds) {
      work.push({ eventId, localityId: t.localityId, provinceCode: t.provinceCode });
    }
  }
  for (let i = 0; i < work.length; i += APPLY_BATCH) {
    const batch = work.slice(i, i + APPLY_BATCH);
    const values = sql.join(
      batch.map((w) => sql`(${w.eventId}::uuid, ${w.localityId}::uuid, ${w.provinceCode}::text)`),
      sql`, `,
    );
    const updated = await exec.transaction(async (tx) => {
      const res = (await tx.execute(sql`
        update public.event_places p
           set locality_id = v.locality_id,
               province_code = v.province_code,
               method = 'legacy_unique_name'
          from (values ${values}) as v(event_id, locality_id, province_code)
         where p.event_id = v.event_id
           and p.method = 'unresolved'
           and p.locality_id is null
           and exists (
             select 1 from public.ar_localities l
              where l.id = v.locality_id
                and l.province_code = v.province_code
                and l.removed_at is null)
        returning p.event_id
      `)) as unknown as unknown[];
      return res.length;
    });
    result.batches += 1;
    result.updated += updated;
    result.skipped += batch.length - updated;
    onBatch?.(result);
  }
  return result;
}
