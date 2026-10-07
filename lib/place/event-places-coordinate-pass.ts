// The coordinate pass over UNRESOLVED event_places rows whose name is a
// HOMONYM — plan maestro A2, 2026-10-07. DRY RUN ONLY.
//
// The name pass (lib/place/event-places-name-pass.ts) leaves a row unresolved
// when its (province, locality) name matches more than one live catalogue row
// of the province: 7 such pairs in Córdoba on staging, plus others elsewhere.
// It never picks the first homonym, and neither does this pass. What it adds
// is ONE more piece of evidence the row's own event may carry: the event's
// coordinates (pet_events.location_lat / location_lng). A homonym is settled
// only when that point lies clearly next to ONE of the candidates:
//
//   resolved    the nearest candidate centroid is within MAX_DISTANCE_KM of
//               the point, AND the runner-up is farther by at least
//               MIN_MARGIN_KM and at least MIN_RATIO times as far;
//   everything else stays unresolved, for a person, with its reason:
//     no_coords                  the event carries no usable point;
//     candidate_without_centroid some candidate has no centroid, so the
//                                comparison would be blind on one side;
//     outside_all                the point is farther than MAX_DISTANCE_KM
//                                from EVERY candidate (it says nothing about
//                                which of them is the home);
//     too_close_to_call          two candidates are about equally near.
//
// CENTROIDS, NOT POLYGONS. ar_localities carries a centroid per row and the
// local stack has no PostGIS, so "inside" is approximated as "within
// MAX_DISTANCE_KM of the centroid". The margin rule is what keeps that honest:
// a point between two towns is never assigned to either. Some homonyms are ONE
// town split by a department border (Mechita, Buenos Aires: centroids ~1 km
// apart; Córdoba has two such names) — no point can settle those, and the
// pass says "too close to call" for every one of their rows.
//
// ONLY SPINE-SHAPED ROWS WOULD BE WRITTEN — the same rule as the name pass:
// a row in the 0250 trigger's shape can be a deliberate verdict of the report
// policy. And nothing is written at all yet: the event_places method CHECK
// (0250) has no value for "a homonym settled by the event's coordinates"
// (geocode_unique means a GEOCODED name that the pin corroborated, which is
// not what happened here), so an apply needs that value decided first. This
// module only counts.
//
// Executor-first, reads only. The operator door is
// scripts/place-resolve-event-places-by-coordinates.ts.

import { sql } from "drizzle-orm";

import type { db } from "@/db";
import { extractEnteredName, unaskable } from "@/lib/place/event-place-names";
import { resolveName } from "@/lib/place/resolve-place";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type CoordinatePassExecutor = typeof db | Tx;

/** The farthest a point may be from the chosen candidate's centroid. */
export const MAX_DISTANCE_KM = 20;
/** The runner-up must be at least this much farther than the winner… */
export const MIN_MARGIN_KM = 10;
/** …and at least this many times as far. */
export const MIN_RATIO = 2;

/** Rows per read page. */
const READ_PAGE = 5000;

export type Point = { lat: number; lng: number };

export type CandidateCentroid = {
  localityId: string;
  localityName: string;
  departmentName: string | null;
  lat: number | null;
  lng: number | null;
};

export type CoordinateUnresolvedReason =
  | "no_coords"
  | "candidate_without_centroid"
  | "outside_all"
  | "too_close_to_call";

export type CoordinateDecision =
  | { verdict: "resolved"; localityId: string; distanceKm: number; runnerUpKm: number }
  | {
      verdict: "unresolved";
      reason: CoordinateUnresolvedReason;
      nearestKm: number | null;
      runnerUpKm: number | null;
    };

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in km. */
export function haversineKm(a: Point, b: Point): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A usable point: both numbers finite and on the globe; (0, 0) is a placeholder, not a place. */
export function usablePoint(lat: unknown, lng: unknown): Point | null {
  const la = typeof lat === "string" ? Number(lat) : lat;
  const ln = typeof lng === "string" ? Number(lng) : lng;
  if (typeof la !== "number" || typeof ln !== "number") return null;
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  if (la === 0 && ln === 0) return null;
  return { lat: la, lng: ln };
}

/**
 * Which homonym the point names, or why it names none. Pure. Needs at least
 * two candidates (a single one is the name pass's business, not this one's).
 */
export function decideByCoordinates(
  point: Point | null,
  candidates: readonly CandidateCentroid[],
): CoordinateDecision {
  const none = (
    reason: CoordinateUnresolvedReason,
    nearestKm: number | null = null,
    runnerUpKm: number | null = null,
  ) => ({ verdict: "unresolved", reason, nearestKm, runnerUpKm }) as const;
  if (point === null) return none("no_coords");
  if (candidates.length < 2) throw new Error("decideByCoordinates needs two or more candidates");
  if (candidates.some((c) => usablePoint(c.lat, c.lng) === null)) {
    return none("candidate_without_centroid");
  }
  const ranked = candidates
    .map((c) => ({
      id: c.localityId,
      km: haversineKm(point, { lat: c.lat as number, lng: c.lng as number }),
    }))
    .sort((a, b) => a.km - b.km);
  const [first, second] = ranked as [(typeof ranked)[0], (typeof ranked)[0]];
  if (first.km > MAX_DISTANCE_KM) return none("outside_all", first.km, second.km);
  if (second.km - first.km < MIN_MARGIN_KM || second.km < MIN_RATIO * first.km) {
    return none("too_close_to_call", first.km, second.km);
  }
  return { verdict: "resolved", localityId: first.id, distanceKm: first.km, runnerUpKm: second.km };
}

export type CoordinatePassScope = {
  /** Restrict the pass to these pets (tests). Absent = the whole table. */
  petIds?: readonly string[];
};

/** How each read reaches the database (the operator wraps each in READ ONLY). */
export type ReadRunner = <T>(read: (exec: CoordinatePassExecutor) => Promise<T>) => Promise<T>;

type Row = {
  eventId: string;
  provinceCode: string | null;
  entered: unknown;
  lat: string | null;
  lng: string | null;
};

export type HomonymPair = {
  provinceCode: string;
  locality: string;
  candidates: CandidateCentroid[];
  rows: number;
  writableRows: number;
  resolvedRows: number;
  /** Spine-shaped rows the pass WOULD write (an apply needs a method value first). */
  resolvedWritableRows: number;
  byReason: Record<CoordinateUnresolvedReason, number>;
  /** Resolved rows per chosen candidate id. */
  chosen: Record<string, number>;
};

export type CoordinatePassInventory = {
  unresolvedRows: number;
  /** Rows whose name is a homonym — the only ones this pass looks at. */
  homonymRows: number;
  pairs: HomonymPair[];
  totals: {
    resolved: number;
    resolvedWritable: number;
    byReason: Record<CoordinateUnresolvedReason, number>;
  };
  /** Per-row decisions, for tests and for a later apply. */
  decisions: Array<{
    eventId: string;
    spine: boolean;
    pairKey: string;
    decision: CoordinateDecision;
  }>;
};

function scopeClause(scope: CoordinatePassScope) {
  if (!scope.petIds) return sql``;
  if (scope.petIds.length === 0) return sql` and false`;
  return sql` and p.pet_id in (${sql.join(
    scope.petIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

async function unresolvedWithPoints(run: ReadRunner, scope: CoordinatePassScope): Promise<Row[]> {
  const out: Row[] = [];
  let after: string | null = null;
  for (;;) {
    const cursor: string | null = after;
    const page: Row[] = await run(
      async (exec): Promise<Row[]> =>
        (await exec.execute(sql`
      select p.event_id::text as "eventId", p.province_code as "provinceCode", p.entered,
             e.location_lat::text as lat, e.location_lng::text as lng
        from public.event_places p
        join public.pet_events e on e.id = p.event_id
       where p.method = 'unresolved'
         and (${cursor}::uuid is null or p.event_id > ${cursor}::uuid)
         ${scopeClause(scope)}
       order by p.event_id
       limit ${READ_PAGE}
    `)) as unknown as Row[],
    );
    out.push(...page);
    if (page.length < READ_PAGE) break;
    after = page[page.length - 1]?.eventId ?? null;
  }
  return out;
}

async function centroids(
  run: ReadRunner,
  ids: readonly string[],
): Promise<Map<string, { lat: number | null; lng: number | null }>> {
  if (ids.length === 0) return new Map();
  const rows = await run(
    async (exec) =>
      (await exec.execute(sql`
        select id::text as id, latitude::text as lat, longitude::text as lng
          from public.ar_localities
         where id in (${sql.join(
           ids.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})
      `)) as unknown as Array<{ id: string; lat: string | null; lng: string | null }>,
  );
  return new Map(
    rows.map((r) => [
      r.id,
      {
        lat: r.lat === null ? null : Number(r.lat),
        lng: r.lng === null ? null : Number(r.lng),
      },
    ]),
  );
}

function emptyReasons(): Record<CoordinateUnresolvedReason, number> {
  return { no_coords: 0, candidate_without_centroid: 0, outside_all: 0, too_close_to_call: 0 };
}

/**
 * Everything the dry run prints. Reads only: the rows and centroids through
 * `opts.run`, the homonym candidates through THE resolver (resolveName).
 */
export async function inventoryCoordinatePass(
  exec: CoordinatePassExecutor,
  scope: CoordinatePassScope = {},
  opts: { run?: ReadRunner } = {},
): Promise<CoordinatePassInventory> {
  const run: ReadRunner = opts.run ?? ((read) => read(exec));
  const rows = await unresolvedWithPoints(run, scope);

  // Ask the resolver once per distinct pair; keep the homonyms.
  const pairs = new Map<string, HomonymPair>();
  const notHomonym = new Set<string>();
  const decisions: CoordinatePassInventory["decisions"] = [];
  const totals = { resolved: 0, resolvedWritable: 0, byReason: emptyReasons() };
  let homonymRows = 0;

  for (const r of rows) {
    const name = extractEnteredName(r.entered, r.provinceCode);
    if (unaskable(name)) continue;
    const key = `${name.provinceCode}\u0000${name.locality}`;
    if (notHomonym.has(key)) continue;
    let pair = pairs.get(key);
    if (!pair) {
      const answer = await resolveName(name.provinceCode as string, name.locality as string);
      if (answer.status !== "ambiguous" || answer.candidates.length < 2) {
        notHomonym.add(key);
        continue;
      }
      const located = await centroids(
        run,
        answer.candidates.map((c) => c.localityId),
      );
      pair = {
        provinceCode: name.provinceCode as string,
        locality: name.locality as string,
        candidates: answer.candidates.map((c) => ({
          localityId: c.localityId,
          localityName: c.localityName,
          departmentName: c.departmentName,
          lat: located.get(c.localityId)?.lat ?? null,
          lng: located.get(c.localityId)?.lng ?? null,
        })),
        rows: 0,
        writableRows: 0,
        resolvedRows: 0,
        resolvedWritableRows: 0,
        byReason: emptyReasons(),
        chosen: {},
      };
      pairs.set(key, pair);
    }
    homonymRows += 1;
    const spine = name.shape === "spine";
    pair.rows += 1;
    if (spine) pair.writableRows += 1;
    const decision = decideByCoordinates(usablePoint(r.lat, r.lng), pair.candidates);
    decisions.push({ eventId: r.eventId, spine, pairKey: key, decision });
    if (decision.verdict === "resolved") {
      pair.resolvedRows += 1;
      totals.resolved += 1;
      pair.chosen[decision.localityId] = (pair.chosen[decision.localityId] ?? 0) + 1;
      if (spine) {
        pair.resolvedWritableRows += 1;
        totals.resolvedWritable += 1;
      }
    } else {
      pair.byReason[decision.reason] += 1;
      totals.byReason[decision.reason] += 1;
    }
  }

  return {
    unresolvedRows: rows.length,
    homonymRows,
    pairs: [...pairs.values()].sort((a, b) => b.rows - a.rows),
    totals,
    decisions,
  };
}
