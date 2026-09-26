// Where a notification about an event goes when the event says where it
// OCCURRED (PO S10, 2026-09-26, health chain).
//
// A non-rabies ENO row, an outbreak signal's authority notice and the ENO
// govt fan-out used to route by the pet's CURRENT home, ignoring the event's
// own place. The PO rule: route to where it occurred; a place that resolved to
// no catalogue row still names its province, so it goes to that province;
// never to the pet's home when the event carries a place.
//
//   resolved → the catalogue row: province from its code, locality name read
//              BY ID in the caller's transaction (never a homonym by name).
//   entered only → its province, canonicalised; locality null (a
//              province-level notice); method 'unresolved'.
//   no place, or a place with no readable province → null: the caller keeps
//              its own fallback (the pet's home snapshot).

import { eq } from "drizzle-orm";

import { arLocalities } from "@/db/schema";
import { canonicalProvinceNameForStorage } from "@/lib/domain/jurisdiction-canonical";
import { provinceByCode } from "@/lib/reference/ar-provincias";

import type { ResolvedEnoTarget } from "./eno-target-jurisdiction";

type Reader = Pick<typeof import("@/db").db, "select">;

type PayloadPlace = {
  entered?: { province?: string | null } | null;
  resolved?: { locality_id?: string; province_code?: string; method?: string } | null;
};

export async function eventPlaceTarget(
  reader: Reader,
  payload: Record<string, unknown>,
): Promise<ResolvedEnoTarget | null> {
  const place = payload.place as PayloadPlace | undefined;
  if (!place || typeof place !== "object") return null;

  const resolved = place.resolved;
  if (resolved?.locality_id) {
    const province = provinceByCode(resolved.province_code)?.name ?? null;
    const [row] = await reader
      .select({ localityName: arLocalities.localityName })
      .from(arLocalities)
      .where(eq(arLocalities.id, resolved.locality_id))
      .limit(1);
    if (!province) return null;
    return {
      jurisdictionProvince: province,
      jurisdictionLocality: row?.localityName ?? null,
      place: { localityId: resolved.locality_id, placeMethod: resolved.method ?? null },
    };
  }

  const province = canonicalProvinceNameForStorage(place.entered?.province ?? null);
  if (!province) return null;
  return {
    jurisdictionProvince: province,
    jurisdictionLocality: null,
    place: { localityId: null, placeMethod: "unresolved" },
  };
}
