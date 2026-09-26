// Read model: the verified orgs the titular may ask — the picker's list.
//
// ONE READ FOR TWO DOORS (2026-09-10). This query and its zone filter lived
// inline in `app/(app)/mis-mascotas/[publicToken]/buscar-hogar/page.tsx` as
// `findCoveringOrgs`; when `GET /api/v1/pets/{token}/rehome` needed the same
// list, copying the function would have been the fifth copy of the coverage
// predicate the design already names as drift (R5). The page calls this now.
//
// THE PREDICATE IS THE USE-CASE'S OWN. `coverageAreaCoversZone` is what
// `requestRehomeSponsorship` refuses on (W-4); a list derived from anything
// else would offer an org the write then rejects. The province narrows the
// query in SQL, the locality half is decided here in code, exactly as the page
// did — one org can declare a province-wide row and a locality row, and both
// must fold into one entry.
//
// NO PROVINCE, NO LIST, and the caller says why: a pet with no registered
// province cannot be matched against anybody's coverage, and the honest answer
// is the empty state that sends the person to edit the profile — not a list of
// every org in the country.

import { type PetZone, orgCoversZone } from "../domain/rehome-rules";
import type { RehomeCandidatesPort } from "./ports";

/** One org the titular may ask, as the picker draws it. */
export type CoveringOrg = {
  id: string;
  publicToken: string;
  displayName: string;
  orgType: string;
  /** The locality (or province) of the coverage row that reached the pet's zone. */
  locality: string | null;
};

export async function listCoveringOrgs(
  zone: PetZone,
  deps: { repo: RehomeCandidatesPort },
): Promise<CoveringOrg[]> {
  if (!zone.province) return [];

  const rows = await deps.repo.findSponsorCandidatesInProvince(zone.province);
  // The `coverage` flag decides the path (localidades-por-id D5); a zone
  // without a localityId always takes the name rule.
  const mode = (await deps.repo.coverageMode?.()) ?? "name";

  const seen = new Set<string>();
  const out: CoveringOrg[] = [];
  for (const row of rows) {
    if (!orgCoversZone([row.coverage], zone, mode)) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({
      id: row.id,
      publicToken: row.publicToken,
      displayName: row.displayName,
      orgType: row.orgType,
      locality: row.coverage.jurisdictionLocality ?? row.coverage.jurisdictionProvince ?? null,
    });
  }
  return out;
}
