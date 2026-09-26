// What one govt grant covers on the ID path — localidades-por-id D2.
//
// public.govt_scope(user) (migration 0257) answers per grant:
//   legacy    authority_unit_id NULL: the grant keeps its (province, locality)
//             NAME pair and the name semantics every consumer already applies
//             (whole-province sentinel included). No place is attached, so on
//             the id path a legacy grant answers exactly as on the name path.
//   province  a provincial unit: the whole province, resolved rows and
//             unresolved ones alike.
//   locality  any other unit: its ACTIVE member localities, by catalogue id.
//             A row whose place never resolved has no locality_id and never
//             matches one (P1/P3: an unresolved place reaches only its
//             province).
//
// Pure: the loader is lib/place/scope.ts.

export type GovtScopeSource = "legacy" | "province" | "locality";

export type GovtScopeRow = {
  assignmentId: string;
  source: GovtScopeSource;
  provinceCode: string | null;
  localityId: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
};

/** The id-path place of ONE unit grant. Legacy grants have none. */
export type GrantPlace =
  | { path: "province"; provinceCode: string }
  | { path: "locality"; provinceCode: string; localityIds: string[] };

export function grantPlacesByAssignment(rows: readonly GovtScopeRow[]): Map<string, GrantPlace> {
  const byGrant = new Map<string, GrantPlace>();
  const members = new Map<string, { provinceCode: string; ids: Set<string> }>();
  for (const r of rows) {
    if (r.source === "province" && r.provinceCode) {
      byGrant.set(r.assignmentId, { path: "province", provinceCode: r.provinceCode });
    } else if (r.source === "locality" && r.provinceCode && r.localityId) {
      const entry = members.get(r.assignmentId) ?? {
        provinceCode: r.provinceCode,
        ids: new Set<string>(),
      };
      entry.ids.add(r.localityId);
      members.set(r.assignmentId, entry);
    }
  }
  for (const [assignmentId, { provinceCode, ids }] of members) {
    byGrant.set(assignmentId, {
      path: "locality",
      provinceCode,
      localityIds: [...ids].sort(),
    });
  }
  return byGrant;
}
