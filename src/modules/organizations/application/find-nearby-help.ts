// Use-case: the finder's plan-B list — nearest vets (when asked) and the
// organizations nearby that receive found animals (P4; design note
// docs/superpowers/specs/2026-10-p4-receptoras-cercanas.md §4).
//
// Two doors reach it:
//   - /p/{token}/encontre's submit action, with the point the finder placed BY
//     HAND on the map (W8: the product never reads the device's location). That
//     action is already rate-limited per (IP, token) and per token.
//   - findNearbyHelpAction (the public page /encontre-un-animal), with a
//     catalogue LOCALITY the finder picked — never a coordinate from the
//     client. Its per-IP limit is checked here, BEFORE any read.
//
// The finder's place is coarsened before the first query and goes nowhere
// else: not into a row, not into a log line, not into the result (the result
// names a locality, never a point). An error is reported by the caller WITHOUT
// the input.
//
// No auth: an anonymous finder is the whole audience. Nothing here reads, or
// can reach, a pet's owner.

import {
  type GeoPoint,
  type NearbyHelp,
  coarsenPoint,
  isPlausibleArPoint,
} from "@/src/modules/organizations/domain/nearby-help";
import {
  type HelpPlace,
  localGovernmentName,
  queryMunicipalService,
  queryNearbyReceivers,
  queryNearbyVets,
  readHelpPlaceById,
  readHelpPlaceNear,
} from "@/src/modules/organizations/infrastructure/found-animal-help-read";

type Executor = Parameters<typeof queryNearbyReceivers>[1];

export type FindNearbyHelpInput =
  /** A point the finder placed by hand (the /encontre form). */
  | { kind: "point"; point: GeoPoint; includeVets: boolean }
  /** A catalogue locality the finder picked (the public page). */
  | { kind: "locality"; localityId: string; includeVets: boolean };

export type FindNearbyHelpDeps = {
  /** Test seam: run every read on this executor (e.g. a READ ONLY transaction). */
  executor?: Executor;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The list for one place, or null when the input names no usable place (an
 * implausible point, an unknown locality id).
 */
export async function findNearbyHelp(
  input: FindNearbyHelpInput,
  deps: FindNearbyHelpDeps = {},
): Promise<NearbyHelp | null> {
  const { executor } = deps;

  let place: HelpPlace | null;
  let point: GeoPoint | null;
  if (input.kind === "point") {
    if (!isPlausibleArPoint(input.point)) return null;
    // Coarsened FIRST: nothing below ever sees the point the finder placed.
    point = coarsenPoint(input.point);
    place = await readHelpPlaceNear(point, executor);
  } else {
    if (!UUID_RE.test(input.localityId)) return null;
    place = await readHelpPlaceById(input.localityId, executor);
    if (!place) return null;
    point = place.point ? coarsenPoint(place.point) : null;
  }

  const [vets, receivers] = point
    ? await Promise.all([
        input.includeVets ? queryNearbyVets(point, executor) : Promise.resolve([]),
        queryNearbyReceivers(point, executor),
      ])
    : [[], []];

  let fallback: NearbyHelp["fallback"] = null;
  if (receivers.length === 0) {
    const service = place ? await queryMunicipalService(place, executor) : null;
    const government = place ? localGovernmentName(place) : null;
    fallback = service
      ? { kind: "municipal_service", card: service }
      : government
        ? { kind: "local_government", name: government }
        : { kind: "general" };
  }

  return {
    vets,
    receivers,
    fallback,
    place: place ? { province: place.provinceName, locality: place.localityName } : null,
  };
}

export type LookupNearbyHelpResult =
  | { ok: true; help: NearbyHelp }
  | { ok: false; error: "rate_limited" | "invalid_place" | "unavailable" };

/**
 * The public page's door: the per-IP limit first (no read at all when over
 * it), then a locality id — never a coordinate.
 */
export async function lookupNearbyHelpForLocality(
  input: { localityId: string; includeVets: boolean },
  deps: FindNearbyHelpDeps & { isThrottled: () => Promise<boolean> },
): Promise<LookupNearbyHelpResult> {
  if (await deps.isThrottled()) return { ok: false, error: "rate_limited" };
  const help = await findNearbyHelp(
    { kind: "locality", localityId: input.localityId, includeVets: input.includeVets },
    deps,
  );
  return help ? { ok: true, help } : { ok: false, error: "invalid_place" };
}
