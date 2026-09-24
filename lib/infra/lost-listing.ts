// Lost-pet listing — shared types, label helpers, and URL codecs for the
// /perdidas feed. Mirror of `lib/adoption-listing.ts`. This module is
// intentionally free of `db` imports so it can be safely consumed by
// client components like `LostFiltersBar.tsx` without dragging the
// `postgres` driver into the client bundle.
//
// The DB query (`queryLostListing`) lives in
// `@/src/modules/lost/infrastructure/lost-listing-read`.

// Pure, dependency-free (no db, no next) — safe for the client bundle.
import { firstSearchParam } from "@/lib/utils/search-params";

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------

// Time-since-lost buckets — used both for the quick filter chips and for
// the urgency chip rendered on each card.
//
//   critical   marked lost in the last 24 hours
//   recent     marked lost in the last 7 days
//   older      marked lost more than 7 days ago
//
// Derived from `markedLostAt`, never stored on the row.
export const LOST_URGENCY_LEVELS = ["critical", "recent", "older"] as const;
export type LostUrgency = (typeof LOST_URGENCY_LEVELS)[number];

export const LOST_TIME_BUCKETS = ["today", "week", "month"] as const;
export type LostTimeBucket = (typeof LOST_TIME_BUCKETS)[number];

export function lostUrgencyFor(markedLostAt: Date | null, now: Date = new Date()): LostUrgency {
  if (!markedLostAt) return "older";
  const ms = now.getTime() - markedLostAt.getTime();
  if (ms < 24 * 60 * 60 * 1000) return "critical";
  if (ms < 7 * 24 * 60 * 60 * 1000) return "recent";
  return "older";
}

// Canonical "how long ago was it lost" label — the SINGLE source of truth for
// both the /perdidas card urgency chip AND the public credential's lost-recency
// chip (formatLostSince delegates here). Two divergences motivated the merge
// (Cowork B2 / consistency):
//   1. the old card bucketed by WEEKS, which produced "Hace 0 meses" at 28-29
//      days (weeks=4 skipped the <4 branch, months=floor(28/30)=0);
//   2. the card said "Hace 3 semanas" while the detail said "hace 27 días" for
//      the same pet — same instant, two vocabularies.
// Fix: DAY granularity below one month (no weeks, so no "0 meses"), one shared
// helper. Returns lowercase; the card chip uppercases via CSS (`uppercase`).
export function lostTimeLabel(markedLostAt: Date | null, now: Date = new Date()): string {
  if (!markedLostAt) return "—";
  const ms = now.getTime() - markedLostAt.getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return minutes <= 1 ? "recién" : `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  // Below one month: always days (never "0 meses"). days >= 1 here (hours >= 24).
  if (days < 30) return days === 1 ? "hace 1 día" : `hace ${days} días`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "hace 1 mes" : `hace ${months} meses`;
  const years = Math.floor(days / 365);
  return years === 1 ? "hace 1 año" : `hace ${years} años`;
}

// ---------------------------------------------------------------------------
// Filters + cursor
// ---------------------------------------------------------------------------

export type LostListingFilters = {
  species?: string;
  province?: string;
  locality?: string;
  color?: string;
  /** Time bucket — only the latest `status_changed → 'lost'` event matters. */
  visto?: LostTimeBucket;
  /** Quick chip: only critical (marked lost in last 24h). */
  criticality?: LostUrgency;
  hasMicrochip?: boolean;
  isSterilized?: boolean;
};

export type LostListingCursor = {
  /** ISO timestamp of the latest `status_changed → 'lost'` event. */
  markedLostAt: string;
  id: string;
};

export type LostListingItem = {
  petId: string;
  petPublicToken: string;
  name: string;
  species: string;
  breed: string | null;
  sex: string;
  color: string | null;
  primaryPhotoId: string | null;
  primaryPhotoStoragePath: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  /** Presence only — the canonical chip code is never read into this DTO.
   *  /perdidas is unauthenticated and the card only needs a badge. */
  hasMicrochip: boolean;
  /** Latest `status_changed → 'lost'` event timestamp. */
  markedLostAt: Date;
  /** Pre-applied privacy: null when the owner opted out via
   *  `discloseLastLocationWhenLost = false`, even if the event had it. */
  lastSeenDescription: string | null;
  /** Presence only — whether the current last-seen record carries a map pin
   *  (coords never enter this DTO, same standard as hasMicrochip). Lets the
   *  card say "Punto marcado en el mapa" instead of claiming no location
   *  exists when the record is pin-only. Always false when the owner opted
   *  out of location disclosure. */
  lastSeenHasPin: boolean;
  /** Whether the pet has any `sterilization_performed` event. */
  isSterilized: boolean;
  /** Owner-controlled flag governing whether the public sees last-seen
   *  location at all. Mirrored here so the card can hide its location box. */
  discloseLastLocationWhenLost: boolean;
};

// ---------------------------------------------------------------------------
// Search params codec — URL is source of truth (D11)
// ---------------------------------------------------------------------------

export function parseSearchParams(params: Record<string, string | string[] | undefined>): {
  filters: LostListingFilters;
  cursor: LostListingCursor | null;
} {
  const filters: LostListingFilters = {};
  // Was a local copy of the same three lines that lived in
  // adoption-listing.ts. Both are now the shared helper — the behavior these
  // two files already had correct is the behavior ~27 page files still lack.
  const pick = (k: string): string | undefined => firstSearchParam(params[k]);

  const species = pick("species");
  if (species) filters.species = species;
  const province = pick("provincia");
  if (province) filters.province = province;
  const locality = pick("localidad");
  if (locality) filters.locality = locality;
  const color = pick("color");
  if (color) filters.color = color;

  const visto = pick("visto");
  if (visto && (LOST_TIME_BUCKETS as readonly string[]).includes(visto)) {
    filters.visto = visto as LostTimeBucket;
  }

  // Quick filter: only critical. The other urgency levels are derived
  // automatically and don't have their own chips.
  if (pick("criticidad") === "critical") filters.criticality = "critical";

  if (pick("con_chip") === "true") filters.hasMicrochip = true;
  if (pick("castrado") === "true") filters.isSterilized = true;

  // Cursor encoded as "<ISO>|<uuid>"
  const cursorRaw = pick("cursor");
  let cursor: LostListingCursor | null = null;
  if (cursorRaw) {
    const [iso, id] = cursorRaw.split("|");
    if (iso && id) cursor = { markedLostAt: iso, id };
  }

  return { filters, cursor };
}

export function buildSearchParams(
  filters: LostListingFilters,
  cursor: LostListingCursor | null,
): URLSearchParams {
  const out = new URLSearchParams();
  if (filters.species) out.set("species", filters.species);
  if (filters.province) out.set("provincia", filters.province);
  if (filters.locality) out.set("localidad", filters.locality);
  if (filters.color) out.set("color", filters.color);
  if (filters.visto) out.set("visto", filters.visto);
  if (filters.criticality === "critical") out.set("criticidad", "critical");
  if (filters.hasMicrochip === true) out.set("con_chip", "true");
  if (filters.isSterilized === true) out.set("castrado", "true");
  if (cursor) out.set("cursor", `${cursor.markedLostAt}|${cursor.id}`);
  return out;
}
