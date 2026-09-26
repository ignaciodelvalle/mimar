// The id-path read scope of a govt user — localidades-por-id D2.
//
// One question — "what does this user's grant cover?" — answered once, by
// public.govt_scope (migration 0257), for every consumer: the TS scope
// clauses (lib/metrics/scope.ts jurisdictionPairClause), routing and the RLS
// policies. This module loads it and attaches the answer to the user's grants
// when, and only when, the `scope` consumer runs on the id path:
//
//   - `place_read_flags.scope` = 'name' or 'shadow' → no grant carries a
//     place: every clause renders the name pairs it always rendered. (Scope
//     shadow parity is measured offline by scripts/place-parity-sweep.ts —
//     running every read twice in production would double its cost.)
//   - 'id' → each UNIT grant carries its place; each LEGACY grant (unit NULL)
//     still carries none, so it answers exactly as on the name path.
//
// The grants keep their (province, locality) names either way: display, the
// province-level disclosure helpers and every payload-keyed site still read
// them.

import { sql } from "drizzle-orm";

import { db } from "@/db";
import { type PlaceReadMode, readPlaceFlag } from "@/lib/place/flags";
import {
  type GovtScopeRow,
  type GrantPlace,
  grantPlacesByAssignment,
} from "@/lib/place/govt-scope";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export async function loadGovtScope(userId: string, exec: Executor = db): Promise<GovtScopeRow[]> {
  const rows = (await exec.execute(sql`
    select assignment_id::text as "assignmentId", source, province_code as "provinceCode",
           locality_id::text as "localityId", jurisdiction_province as "jurisdictionProvince",
           jurisdiction_locality as "jurisdictionLocality"
      from public.govt_scope(${userId}::uuid)
  `)) as unknown as GovtScopeRow[];
  return rows;
}

export type ScopedGrant = { province: string; locality: string; place?: GrantPlace };

/**
 * A user's active grants as scope clauses read them. `grants` carries each
 * assignment's id and unit; the result drops both and adds `place` to the
 * unit grants when the `scope` consumer runs on the id path (or `opts.mode`
 * says so).
 */
export async function scopedGrants(
  userId: string,
  grants: ReadonlyArray<{
    assignmentId: string;
    province: string;
    locality: string;
    authorityUnitId: string | null;
  }>,
  opts: { exec?: Executor; mode?: PlaceReadMode } = {},
): Promise<ScopedGrant[]> {
  const { exec } = opts;
  const plain = (g: (typeof grants)[number]): ScopedGrant => ({
    province: g.province,
    locality: g.locality,
  });
  if (!grants.some((g) => Boolean(g.authorityUnitId))) return grants.map(plain);
  // `mode` is for the parity sweep and the fences, which must ask the id path
  // without flipping the shared flag; production reads the flag.
  const mode = opts.mode ?? (await readPlaceFlag("scope", exec));
  if (mode !== "id") return grants.map(plain);

  const places = grantPlacesByAssignment(await loadGovtScope(userId, exec));
  return grants.map((g) => {
    const place = g.authorityUnitId ? places.get(g.assignmentId) : undefined;
    // A unit grant govt_scope did not return (a unit with no active member)
    // gets an empty locality set: it matches nothing on the id path rather
    // than falling back to its name pair.
    if (g.authorityUnitId && !place) {
      return { ...plain(g), place: { path: "locality", provinceCode: "", localityIds: [] } };
    }
    return place ? { ...plain(g), place } : plain(g);
  });
}
