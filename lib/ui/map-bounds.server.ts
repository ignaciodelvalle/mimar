// lib/ui/map-bounds.server.ts — SERVER-side bridge between the client-safe
// bounds helpers (lib/ui/map-bounds.ts) and lib/infra/gov-scope.ts's DB-bound
// `jurisdictionBounds`. Split from map-bounds.ts because that module is
// imported by client map components and must never pull db/index.ts into a
// client bundle.
//
// boundsForScope — callers always get a usable bbox: the jurisdiction bbox
// when resolvable, AR_BBOX otherwise (admin's universal scope resolves to
// null, as does a govt viewer whose assignments have no centroids).

import { type DashboardJurisdiction, jurisdictionBounds } from "@/lib/infra/gov-scope";

import { AR_BBOX, type Bbox } from "./map-bounds";

/**
 * Resolves a MapLibre bbox to fit for the given jurisdictions, falling back
 * to AR_BBOX when jurisdictionBounds returns null (admin universal scope, or
 * a govt viewer whose assignments have no resolvable centroids) — callers
 * always get a usable bbox, never null.
 */
export async function boundsForScope(jurisdictions: DashboardJurisdiction[]): Promise<Bbox> {
  const bounds = await jurisdictionBounds(jurisdictions);
  return bounds ?? AR_BBOX;
}
