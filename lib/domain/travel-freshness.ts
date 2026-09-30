// Freshness of curated travel reference data (viajes-fase-2, design D2/D6).
//
// Corridor rules and airline policies are regulations and commercial policies
// that change without notice: GOL suspended hold transport in 2024, ITA changed
// its policy twice in 2025, Chile made the microchip mandatory in July 2026.
// Every datum miMAR shows about them therefore carries WHERE it came from and
// WHEN a person last checked it, and it has a date after which it must be
// checked again.
//
// Three states, and none of them is green:
//   · fresh      — verified at its source and inside its review window;
//   · expired    — past `reviewBy`: it may still be right, nobody knows;
//   · unverified — never confirmed against the source itself (a 403 on the
//                  official page, two sources that disagree, a third-party
//                  aggregator). It carries a `note` saying which.
// Only `fresh` lets an obligation read as settled. The UI and the fence both
// ask `freshnessOf`, so they cannot disagree about which state a datum is in.

/** How long a verification holds before it must be redone, in days. */
export const FRESHNESS_TTL_DAYS = {
  /** Destination-country regulations: they change by decree, not weekly. */
  country: 180,
  /** Airline policies (and miMAR's airline-facing breed list): they change often. */
  airline: 90,
} as const;

export type FreshnessKind = keyof typeof FRESHNESS_TTL_DAYS;

export type Verification = "verified" | "unverified";

/** Where a datum came from and when a person last checked it. */
export interface SourceMeta {
  /** Public https URL of the source the value was read from. */
  sourceUrl: string;
  /** ISO date (YYYY-MM-DD) the value was last checked against `sourceUrl`. */
  lastVerifiedAt: string;
  /** ISO date after which the value must be checked again. */
  reviewBy: string;
  verification: Verification;
  /** REQUIRED when unverified: why (e.g. "403 al leer la página oficial"). */
  note?: string;
}

/** A value with its provenance. */
export type Sourced<T> = SourceMeta & { value: T };

export type Freshness = "fresh" | "expired" | "unverified";

/** The calendar date of `now` in UTC, as YYYY-MM-DD. */
export function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Which state a datum is in at `now`. Unverified wins over expired: a value
 * nobody ever confirmed does not become more trustworthy by being recent.
 * Expired means strictly AFTER `reviewBy` — the review date itself still holds.
 */
export function freshnessOf(
  meta: Pick<SourceMeta, "reviewBy" | "verification">,
  now: Date,
): Freshness {
  if (meta.verification === "unverified") return "unverified";
  return isoDate(now) > meta.reviewBy ? "expired" : "fresh";
}
