// Last-resort jurisdiction recovery from the free text of a location field.
//
// WHY THIS EXISTS (P3.1 / PO decision D.11, 2026-07-31)
// -----------------------------------------------------
// A denuncia's (province, locality) is derived CLIENT-side, from the geocoder
// pick or the reverse-geocode of the map pin (components/LocationFields.tsx,
// mode="l2"). When the provider is unreachable — a shared CI/Actions egress IP
// getting 403/429'd from nominatim.openstreetmap.org is the documented case —
// LocationFields still lets the citizen drop a map pin and submit, but the
// hidden `provinceCode`/`localityName` inputs stay EMPTY. The row then lands
// with jurisdiction_province NULL, and `jurisdictionPairClause`
// (lib/metrics/scope.ts) matches on province equality in every branch, so a
// NULL-province row is invisible to EVERY government queue. A citizen files a
// maltrato report and nobody ever sees it.
//
// D.11: on geocoding failure, fall back to the jurisdiction stated in the FORM
// TEXT and mark it NOT VERIFIED. The report is never lost. The PO accepted the
// residual risk (a report routed to the wrong municipality looks attended and
// is not) against the non-negotiable condition that the low-confidence mark is
// VISIBLE in the operator's triage queue — see WelfareDenunciaRow.
//
// WHAT THIS IS NOT
// ----------------
// This is not a geocoder and must never be treated as one. It reads the text
// the citizen typed, splits it on the comma grammar every Argentine address
// uses ("Rivadavia 1234, Quilmes, Buenos Aires"), and asks the SAME catalogs
// the verified path uses (lib/reference/ar-provincias.ts for the province,
// ar_localities for the locality). No network, no fuzzy scoring, no
// coordinates. Every result it produces is a GUESS and is persisted as one.
//
// REJECTED ALTERNATIVE — deriving the province from the map pin's coordinates
// via lib/reference/ar-viewboxes.ts. Those viewboxes are axis-aligned
// RECTANGLES used as a soft search bias; Argentine provinces overlap heavily
// under that approximation (a Buenos Aires bbox swallows CABA whole), so a
// coordinate would frequently resolve to the wrong province with no way to tell.
// A confident wrong answer is worse than the text the citizen actually wrote,
// and D.11 named the form text explicitly.

import { isWholeProvinceLocality } from "@/lib/domain/jurisdiction-canonical";
import {
  localityByName,
  localityDistanceKm,
  nearestLocalities,
  searchLocalities,
} from "@/lib/infra/ar-localidades";
import { type ProvinceCode, provinceByName } from "@/lib/reference/ar-provincias";

export type InferredJurisdiction = {
  /** Canonical province display name, e.g. "Buenos Aires". Never null — a
   * result with no province is not returned at all (it would route nowhere). */
  province: string;
  /** Canonical locality name when a catalog row matched, else null. A
   * province-only result is still useful: the whole-province branch of
   * jurisdictionPairClause matches rows whose locality IS NULL. */
  locality: string | null;
  /** ar_localities uuid PK when the locality resolved, else null (migration 0147). */
  localityId: string | null;
};

/** Country tails an address line commonly ends with; never a jurisdiction. */
const COUNTRY_TAILS = new Set(["argentina", "ar", "arg", "republica argentina"]);

/** Segments this short cannot be a province or a locality name. */
const MIN_SEGMENT_LENGTH = 3;

/** Hard ceiling on catalog lookups per call, so a pathological paste of 200
 * comma-separated fragments cannot turn one submission into 200 queries. */
const MAX_SEGMENTS = 8;

function normalizeSegment(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split a free-text address into candidate jurisdiction segments, broadest
 * LAST — the order Argentine address grammar writes them in.
 *
 * Pure and exported for unit tests: this is where the parsing decisions live
 * (comma/newline separators, country tail dropped, postal-code-only and
 * too-short fragments dropped, cap at MAX_SEGMENTS keeping the TAIL because the
 * jurisdiction lives at the end of the line, not the start).
 */
export function addressSegments(text: string | null | undefined): string[] {
  if (!text) return [];
  const segments = text
    .split(/[,\n;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SEGMENT_LENGTH)
    // Drop pure postal codes / house numbers ("1234", "B1878", "C1425DKE").
    .filter((s) => !/^[a-zA-Z]?\d[\dA-Za-z]*$/.test(s))
    .filter((s) => !COUNTRY_TAILS.has(normalizeSegment(s)));
  return segments.length > MAX_SEGMENTS ? segments.slice(-MAX_SEGMENTS) : segments;
}

/**
 * Recover a (province, locality) guess from the free text of a location field.
 * Returns `null` when the text names no province and no unambiguous locality —
 * there is nothing honest to guess and the caller must leave the row
 * jurisdiction-less rather than invent a routing target.
 *
 * Strategy, in order:
 *   1. Scan segments back-to-front for a province name/alias. Argentine address
 *      grammar puts the province last, and scanning backwards means "Córdoba
 *      1234, Palermo, CABA" resolves to CABA (the province) and not to Córdoba
 *      (the street).
 *   2. With a province in hand, scan the segments BEFORE it, back-to-front, for
 *      a catalog locality in that province.
 *   3. With no province anywhere, fall back to an EXACT catalog locality name
 *      across all provinces ("Quilmes" alone) — accepted only when every match
 *      agrees on the province, so an ambiguous name never picks a municipality
 *      by coin flip.
 */
export async function inferJurisdictionFromText(
  text: string | null | undefined,
): Promise<InferredJurisdiction | null> {
  const segments = addressSegments(text);
  if (segments.length === 0) return null;

  // 1. Province, searching from the broadest end.
  for (let i = segments.length - 1; i >= 0; i--) {
    const province = provinceByName(segments[i]);
    if (!province) continue;

    // 2. Locality within that province, from the segments to its left.
    for (let j = i - 1; j >= 0; j--) {
      const locality = await localityByName(province.code as ProvinceCode, segments[j]);
      if (locality) {
        return {
          province: province.name,
          locality: locality.localityName,
          localityId: locality.id,
        };
      }
    }
    return { province: province.name, locality: null, localityId: null };
  }

  // 3. No province named. Try an exact locality match across provinces.
  for (let i = segments.length - 1; i >= 0; i--) {
    const candidate = segments[i];
    const matches = await searchLocalities({ query: candidate, limit: 10 });
    const normalized = normalizeSegment(candidate);
    const exact = matches.filter((m) => normalizeSegment(m.localityName) === normalized);
    if (exact.length === 0) continue;

    const provinceCodes = new Set(exact.map((m) => m.provinceCode));
    if (provinceCodes.size !== 1) continue; // ambiguous across provinces — refuse to guess

    const province = provinceByName(exact[0].provinceName);
    if (!province) continue;

    // Re-read through localityByName so the returned row is the SAME
    // deterministic pick the verified path would have produced (search orders
    // by relevance/category; localityByName orders by department).
    const locality = await localityByName(province.code as ProvinceCode, exact[0].localityName);
    return {
      province: province.name,
      locality: locality?.localityName ?? exact[0].localityName,
      localityId: locality?.id ?? null,
    };
  }

  return null;
}

export type RoutableJurisdiction = {
  province: string | null;
  locality: string | null;
  localityId: string | null;
  /** TRUE when the pair below came from the form text, not from a geocoder —
   * or when a client-echoed pair was not corroborated by its own coordinates
   * (A11-G1). Persisted as welfare_reports.jurisdiction_unverified (migration 0162) and
   * rendered in the triage queue. */
  unverified: boolean;
};

// ---------------------------------------------------------------------------
// Corroboration of a client-supplied pair against its own coordinates (A11-G1)
// ---------------------------------------------------------------------------

/** How many nearest catalog localities the province check looks at. */
const CORROBORATION_NEIGHBOURS = 10;

/** A claimed locality counts as consistent with the point when its centroid is
 * this close, or when it is among the few nearest settlements (sparse areas,
 * where the nearest town may be further away than this). */
const LOCALITY_RADIUS_KM = 25;
const LOCALITY_NEAREST_RANK = 3;

/**
 * Do the coordinates that came WITH a jurisdiction pair agree with it?
 *
 * The pair on the verified arm is an ECHO: the web's LocationFields and the
 * phone's `resolve_location` pick both hand back what a geocoder said, and a
 * client can send any pair it likes next to any pin. This does not re-derive a
 * jurisdiction (the header explains why coordinates cannot do that honestly);
 * it only asks whether the claim is PLAUSIBLE for the point:
 *
 *   - province: it must be the province of at least one of the nearest
 *     catalogued localities. Near a border both provinces show up, so an
 *     honest pin is not penalised; a pin in Salta claiming CABA is caught.
 *   - locality (unless it is the whole-province aggregate): it must have
 *     resolved to a catalog row, and that row's centroid must be within
 *     LOCALITY_RADIUS_KM of the point, or among the nearest few settlements.
 *     A locality name with no catalog row answers false — nothing corroborates it.
 *
 * Any doubt answers false — the caller then keeps the pair but marks it
 * unverified, which is the visible, safe state (D.11). Residual, stated: a
 * spoof across a border the pin actually sits next to still passes.
 */
export async function coordinatesCorroborateJurisdiction(input: {
  province: string;
  locality: string | null;
  localityId: string | null;
  lat: number;
  lng: number;
}): Promise<boolean> {
  const province = provinceByName(input.province);
  if (!province) return false;

  const point = { lat: input.lat, lng: input.lng };
  const near = await nearestLocalities({ ...point, limit: CORROBORATION_NEIGHBOURS });
  if (!near.some((n) => n.provinceCode === province.code)) return false;

  const claimedLocality = input.locality?.trim() ?? "";
  if (claimedLocality && isWholeProvinceLocality(province.name, claimedLocality)) return true;
  // No catalog row to measure against. A province-only claim has nothing more
  // to check; a locality NAME that did not resolve to the catalog cannot be
  // corroborated, so it is not verified (security review 2026-09, LOW-2). The
  // soft-mode intake still accepts it — it is only marked.
  if (!input.localityId) return claimedLocality === "";

  const rank = near.findIndex((n) => n.id === input.localityId);
  if (rank >= 0 && rank < LOCALITY_NEAREST_RANK) return true;
  const distance = await localityDistanceKm(input.localityId, point);
  return distance !== null && distance <= LOCALITY_RADIUS_KM;
}

/**
 * The D.11 gate every denuncia intake runs its normalized location through.
 *
 * When the client supplied a province (the geocoder's echo) the pair is kept
 * as-is, and it is marked VERIFIED only if the coordinates sent with it
 * corroborate it (A11-G1). No coordinates, or coordinates that disagree, mark
 * it unverified: a client-echoed pair is a claim, not a verification, and the
 * mark is what the triage queue shows the operator. The routing pair is never
 * rewritten from coordinates.
 *
 * ONLY when the province is missing does it read the form text, and a
 * recovered pair is always marked.
 *
 * When the text yields nothing either, the row stays jurisdiction-less exactly
 * as before — but still marked, because "we could not route this" is precisely
 * what an operator (and the admin queue, which is unscoped and therefore the
 * only surface that can see it) needs to be told. Inventing a jurisdiction to
 * make the mark look tidy would be the worse failure.
 */
export async function resolveRoutableJurisdiction(input: {
  province: string | null;
  locality: string | null;
  localityId: string | null;
  addressText: string | null;
  /** The coordinates submitted with the pair; null when the intake had none. */
  lat: number | null;
  lng: number | null;
}): Promise<RoutableJurisdiction> {
  if (input.province) {
    const corroborated =
      input.lat !== null && input.lng !== null
        ? await coordinatesCorroborateJurisdiction({
            province: input.province,
            locality: input.locality,
            localityId: input.localityId,
            lat: input.lat,
            lng: input.lng,
          })
        : false;
    return {
      province: input.province,
      locality: input.locality,
      localityId: input.localityId,
      unverified: !corroborated,
    };
  }

  const inferred = await inferJurisdictionFromText(input.addressText);
  if (!inferred) {
    return {
      province: null,
      locality: input.locality,
      localityId: input.localityId,
      unverified: true,
    };
  }

  return {
    province: inferred.province,
    // A locality the geocoder somehow supplied without a province is not more
    // trustworthy than the catalog row the text just resolved to — prefer the
    // catalog, fall back to whatever text the caller held.
    locality: inferred.locality ?? input.locality,
    localityId: inferred.localityId,
    unverified: true,
  };
}
