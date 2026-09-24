// The search's query string, parsed once — and the jurisdiction prefill.
//
// WHY THIS IS NOT IN THE ROUTE
// ---------------------------------------------------------------------------
// `check-api-v1-envelope` reads the handler BODY and does not follow calls, which
// is why the auth guard and the limiter calls stay inline there. Parsing is not
// one of those: nothing about it is a boundary, and it is the half of the route
// that has cases worth testing without spinning up a handler.
//
// THE PARAM NAMES ARE THE WEB'S, EXACTLY — `service_kind`, `province`,
// `locality`, `fecha_desde`, `solo_gratis`. They are `snake_case` and one of them
// is in Spanish, which is not this file's taste; it is `/turnos/buscar`'s query
// string, and a person who shares a search from the browser and one who shares it
// from the phone should be describing the same thing. A second vocabulary for one
// search is a second thing to keep in step.

import { and, asc, eq, isNull } from "drizzle-orm";

import { db, ownerships, pets } from "@/db";
import { findServiceKind } from "@/lib/reference/service-kinds";
import type { AppointmentSearchV1 } from "@dim/contract/api";
import { isRealArDay } from "@dim/contract/input";

/** `2026-08-30`. Anything else is treated as absent rather than refused. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export type AppointmentSearchQuery = {
  /**
   * The catalogue code, or `null`.
   *
   * `null` FOR AN UNKNOWN CODE, NOT THE RAW STRING. Falling through to the picker
   * is what the app already does for a missing param, and an unrecognised service
   * is exactly that: no service chosen yet. See the route's header for the QA
   * finding this is the fix for.
   */
  serviceKind: string | null;
  province: string | null;
  locality: string | null;
  /** The earliest day to show, or `null`. Never moves the window backwards. */
  fromDate: Date | null;
  freeOnly: boolean;
};

/**
 * The first value of a repeated param, or `null`.
 *
 * `URLSearchParams.get` already returns the first of a repeated key, so unlike
 * the web's `trimmedSearchParam` there is no `string[]` to defend against here —
 * Next hands a page `?a=1&a=2` as an array and raw `.trim()` on it is a 500. The
 * shape is different and the trimming is the same.
 */
function trimmed(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key);
  if (raw === null) return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

export function parseSearchQuery(params: URLSearchParams): AppointmentSearchQuery {
  const requestedKind = trimmed(params, "service_kind");
  const fechaDesde = trimmed(params, "fecha_desde");

  // A DAY THAT PARSES AND DOES NOT EXIST IS THE CASE THE REGEX MISSES, and
  // finding that out cost this file a test. `"2026-02-31"` matches `ISO_DAY`
  // perfectly, and `new Date("2026-02-31")` does NOT throw and is NOT `NaN` —
  // JavaScript ROLLS IT OVER to 3 March. A search floor silently moved three days
  // forward hides every slot in between and reports nothing.
  //
  // `isRealArDay` is the contract's own round-trip check and it is IMPORTED
  // rather than restated: it already refuses exactly this on the caretaker and
  // record-event schemas, and its header records the same rollover measured twice
  // before. Two implementations of one calendar in one repo is how they stop
  // agreeing.
  //
  // A DAY THAT DOES NOT EXIST IS TREATED AS ABSENT, not refused. A floor is a
  // FILTER, not an assertion — the honest answer to "show me from 31 February" is
  // the whole window, and a 400 over a query param the web quietly ignores would
  // make the phone stricter than the browser for no gain.
  let fromDate: Date | null = null;
  if (fechaDesde && ISO_DAY.test(fechaDesde) && isRealArDay(fechaDesde)) {
    fromDate = new Date(fechaDesde);
  }

  return {
    serviceKind: requestedKind && findServiceKind(requestedKind) ? requestedKind : null,
    province: trimmed(params, "province"),
    locality: trimmed(params, "locality"),
    fromDate,
    // The web's own truthiness: `params.solo_gratis === "true"` and nothing else.
    freeOnly: params.get("solo_gratis") === "true",
  };
}

export type ResolvedJurisdiction = {
  province: string | null;
  locality: string | null;
  source: AppointmentSearchV1["jurisdictionSource"];
};

/**
 * Where to search, when the caller did not say — the web's prefill
 * (`app/(app)/turnos/buscar/page.tsx:48-70`), copied rather than re-derived.
 *
 * It reads the caller's FIRST registered animal and takes its jurisdiction. Only
 * the half the caller left blank is filled, which is the web's behaviour: a
 * person who names a province and no locality gets their pet's locality inside
 * their own province, and the search then widens by subsumption from there.
 *
 * ART. 16 (Ley 25.326) — `pets.deleted_at IS NULL`. This only seeds a search, but
 * a foster or co-owner row SURVIVES the titular's erasure, so without it an erased
 * animal's location would still steer a live third party's search. That is a
 * per-pet read of a dead row, and the web's own query carries the same clause with
 * the same comment.
 *
 * A CALLER WITH NO PETS GETS `source: "none"` AND AN UNFILTERED SEARCH, which is
 * the honest answer: showing every campaign in the country is better than showing
 * none, and it is what the browser does.
 */
export async function defaultJurisdictionForUser(args: {
  userId: string;
  query: AppointmentSearchQuery;
}): Promise<ResolvedJurisdiction> {
  const [firstPet] = await db
    .select({
      province: pets.jurisdictionProvince,
      locality: pets.jurisdictionLocality,
    })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(ownerships.ownerUserId, args.userId),
        isNull(ownerships.endedAt),
        isNull(pets.deletedAt),
      ),
    )
    .orderBy(asc(pets.createdAt))
    .limit(1);

  const province = args.query.province ?? firstPet?.province ?? null;
  const locality = args.query.locality ?? firstPet?.locality ?? null;

  // "requested" only when BOTH halves came from the caller. A search whose
  // locality was guessed is a guessed search even if the province was named, and
  // the flag exists so a client can say so.
  const source: ResolvedJurisdiction["source"] =
    args.query.province && args.query.locality
      ? "requested"
      : province === null && locality === null
        ? "none"
        : "defaulted-from-pet";

  return { province, locality, source };
}
