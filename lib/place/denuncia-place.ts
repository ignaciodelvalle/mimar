// Where a denuncia is routed, and whether the triage queue shows it verified.
//
// localidades-por-id A6. The ONE composition both denuncia doors use — the web
// intakes (public and org, src/modules/welfare/actions.ts) and
// POST /api/v1/welfare-reports — so the two cannot drift.
//
//   1. The place is resolved the way every report is
//      (lib/place/reported-place.ts): the pair to ONE catalogue row or to none
//      (a homonym is province-level, never the alphabetically first
//      department), checked against the pin — and, because the pair on these
//      forms is the geocode of that same pin, a disagreement re-reads the pin.
//      With no pair, the PIN decides before any form text does.
//   2. The D.11 gate (`resolveRoutableJurisdiction`) then does what it always
//      did: corroborates a named place against its coordinates, and only when
//      no province is known at all reads the form text — which no longer picks
//      a homonym either (jurisdiction-from-text.ts).
//   3. A place the person NAMED that could not be resolved is MARKED — the
//      triage queue's "sin verificar" is how an operator learns a report may be
//      province-level or re-read from the pin (spec: unresolved cases keep
//      `jurisdiction_unverified`).
//   4. The place as ENTERED is returned too (`place`), whatever it resolved to
//      — a homonym, or nothing — so the typed locality is never lost (stage A
//      review, P2). `resolved` names only a row the place resolver named; a
//      pair recovered by the D.11 gate from form text is not a resolution.

import type { LocationValue } from "@/lib/domain/location-value";
import type { PlaceMethod } from "@/lib/domain/place";
import type { EventPlace } from "@/lib/events/place-payload";
import {
  type RoutableJurisdiction,
  resolveRoutableJurisdiction,
} from "@/lib/infra/jurisdiction-from-text";
import { toEventPlace } from "@/lib/place/event-place";
import { type UnresolvedReason, resolveMapFormPlace } from "@/lib/place/reported-place";

/** Outcomes that are never "verified", whatever the coordinates say. */
const ALWAYS_MARKED: ReadonlySet<UnresolvedReason> = new Set([
  // The name the person gave names two catalogue rows.
  "ambiguous",
  // The pair and the pin disagreed (only reachable without a pin re-read).
  "pin_disagrees",
  // No name the catalogue could confirm: the province came from the pin alone.
  "pin_only",
]);

export type DenunciaJurisdiction = RoutableJurisdiction & {
  /**
   * The place as entered and as resolved — for the denuncia's event record
   * and, since migration 0248, for the row itself (`welfare_reports.
   * place_entered`): a denuncia about an unregistered animal has no event.
   */
  place: EventPlace;
  /** HOW `localityId` was decided (`welfare_reports.place_method`). */
  placeMethod: PlaceMethod;
};

export async function resolveDenunciaJurisdiction(
  loc: LocationValue,
): Promise<DenunciaJurisdiction> {
  const place = await resolveMapFormPlace(loc);
  const routable = await resolveRoutableJurisdiction({
    province: place.province,
    locality: place.locality,
    localityId: place.localityId,
    addressText: loc.address,
    lat: loc.lat,
    lng: loc.lng,
  });
  const marked = place.unresolvedReason !== null && ALWAYS_MARKED.has(place.unresolvedReason);
  return {
    ...routable,
    unverified: routable.unverified || marked,
    place: toEventPlace(place),
    placeMethod: methodOf(place.localityId, place.method, routable.localityId),
  };
}

/**
 * The method behind the id the row stores. The place resolver's own when it
 * named the row; otherwise an id can only have come from the D.11 recovery of
 * the form text, which accepts a name only when it names ONE row of its
 * province (jurisdiction-from-text.ts) — a folded-name match. No id: no method.
 */
function methodOf(
  resolverId: string | null,
  resolverMethod: PlaceMethod,
  storedId: string | null,
): PlaceMethod {
  if (storedId === null) return "unresolved";
  if (storedId === resolverId) return resolverMethod;
  return "folded_name_unique";
}
