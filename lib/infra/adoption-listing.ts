// Adoption listing — shared catalogs, types, label helpers, and URL
// codecs for the /adoptar feed. This module is intentionally free of
// `db` imports so it can be safely consumed by client components like
// `AdoptionFiltersBar.tsx` and `AdoptionListingForm.tsx`. The DB query
// (`queryAdoptionListing`) lives in `@/src/modules/adoption/infrastructure/adoption-listing-read`.

// Pure, dependency-free (no db, no next) — safe for the client bundle.
import { firstSearchParam } from "@/lib/utils/search-params";

// ---------------------------------------------------------------------------
// Catalogs (kept here so consumers — page, form, filters bar — import from
// one place; labels are es-AR and intentionally separate from DB values)
// ---------------------------------------------------------------------------

export const ADOPTION_AGE_BUCKETS = ["puppy", "junior", "young", "adult", "senior"] as const;
export type AgeBucket = (typeof ADOPTION_AGE_BUCKETS)[number];

export const ADOPTION_SIZE_ESTIMATES = ["small", "medium", "large", "xl"] as const;
export type SizeEstimate = (typeof ADOPTION_SIZE_ESTIMATES)[number];

export const ADOPTION_ENERGY_LEVELS = ["low", "medium", "high"] as const;
export type EnergyLevel = (typeof ADOPTION_ENERGY_LEVELS)[number];

// Age-bucket label resolution honors `sex` for grammatical gender.
// `unknown` falls back to masculine to avoid inventing a gender — matches
// how Argentine refugios speak when the perro/perra isn't disambiguated.
export function ageBucketLabel(bucket: AgeBucket, sex: string): string {
  const feminine = sex === "female";
  switch (bucket) {
    case "puppy":
      return feminine ? "Cachorra" : "Cachorro";
    case "junior":
      return "Junior";
    case "young":
      return "Joven";
    case "adult":
      return feminine ? "Adulta" : "Adulto";
    case "senior":
      return feminine ? "Adulta mayor (Senior)" : "Adulto mayor (Senior)";
  }
}

export function sizeLabel(size: SizeEstimate): string {
  switch (size) {
    case "small":
      return "Chico";
    case "medium":
      return "Mediano";
    case "large":
      return "Grande";
    case "xl":
      return "Extra grande";
  }
}

// Gendered by `sex` — matches ageBucketLabel's convention just above: `unknown`
// falls back to masculine rather than inventing a gender (Argentine refugio
// speech). Previously ungendered ("Activo/a" always), which disagreed with the
// pet's recorded sex on every /adoptar card (QA histórico 2026-07-08).
export function energyLabel(energy: EnergyLevel, sex: string): string {
  const feminine = sex === "female";
  switch (energy) {
    case "low":
      return feminine ? "Tranquila" : "Tranquilo";
    case "medium":
      return feminine ? "Moderada" : "Moderado";
    case "high":
      return feminine ? "Activa" : "Activo";
  }
}

// ---------------------------------------------------------------------------
// Filters + cursor
// ---------------------------------------------------------------------------

export type AdoptionListingFilters = {
  species?: string;
  province?: string;
  locality?: string;
  ageBucket?: AgeBucket;
  sizeEstimate?: SizeEstimate;
  energyLevel?: EnergyLevel;
  goodWithKids?: boolean;
  goodWithDogs?: boolean;
  goodWithCats?: boolean;
  needsYard?: boolean;
  hasMicrochip?: boolean;
  organizationToken?: string;
  /** Free-text search: matches pet name or breed (case-insensitive). */
  searchQuery?: string;
};

export type AdoptionListingCursor = {
  listedAt: string; // ISO
  id: string;
};

export type AdoptionListingItem = {
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
   *  /adoptar is unauthenticated and the card only needs a badge. */
  hasMicrochip: boolean;
  adoptionListedAt: Date;
  adoptionStory: string | null;
  adoptionRequirements: string | null;
  adoptionEnergyLevel: EnergyLevel | null;
  adoptionSizeEstimate: SizeEstimate | null;
  adoptionAgeBucket: AgeBucket | null;
  adoptionGoodWithKids: boolean | null;
  adoptionGoodWithDogs: boolean | null;
  adoptionGoodWithCats: boolean | null;
  adoptionNeedsYard: boolean | null;
  adoptionFeeArs: number | null;
  orgId: string;
  orgPublicToken: string;
  orgDisplayName: string;
  orgAvatarUrl: string | null;
  // Derived booleans for card badges. The presence of an event is the
  // source of truth — we don't materialize these on `pets` because
  // recompute-from-events is cheap and there is no surface that needs
  // them outside the listing.
  isSterilized: boolean;
  /**
   * The listing is a rehome sponsorship (rehome-by-titular, spec REQ-12): the
   * animal lives with its current family and the org runs the evaluation.
   * Decided on the spine (an unmatched `rehome_sponsorship_started`), never on
   * the ownership shape. False for every surrender-path listing.
   */
  livesWithFamily: boolean;
};

// ---------------------------------------------------------------------------
// Search params codec — URL is source of truth (D11)
// ---------------------------------------------------------------------------

export function parseSearchParams(params: Record<string, string | string[] | undefined>): {
  filters: AdoptionListingFilters;
  cursor: AdoptionListingCursor | null;
} {
  const filters: AdoptionListingFilters = {};
  // See lost-listing.ts — same closure, now the shared helper.
  const pick = (k: string): string | undefined => firstSearchParam(params[k]);

  const species = pick("species");
  if (species) filters.species = species;
  const province = pick("provincia");
  if (province) filters.province = province;
  const locality = pick("localidad");
  if (locality) filters.locality = locality;

  const ageBucket = pick("edad");
  if (ageBucket && (ADOPTION_AGE_BUCKETS as readonly string[]).includes(ageBucket)) {
    filters.ageBucket = ageBucket as AgeBucket;
  }
  const sizeEstimate = pick("talle");
  if (sizeEstimate && (ADOPTION_SIZE_ESTIMATES as readonly string[]).includes(sizeEstimate)) {
    filters.sizeEstimate = sizeEstimate as SizeEstimate;
  }
  const energyLevel = pick("energia");
  if (energyLevel && (ADOPTION_ENERGY_LEVELS as readonly string[]).includes(energyLevel)) {
    filters.energyLevel = energyLevel as EnergyLevel;
  }

  if (pick("con_chicos") === "true") filters.goodWithKids = true;
  if (pick("con_perros") === "true") filters.goodWithDogs = true;
  if (pick("con_gatos") === "true") filters.goodWithCats = true;
  if (pick("sin_patio") === "true") filters.needsYard = false;
  if (pick("con_chip") === "true") filters.hasMicrochip = true;

  const org = pick("org");
  if (org) filters.organizationToken = org;

  const q = pick("q");
  // Cap length — user input becomes an ILIKE pattern; unbounded params would
  // hand Postgres arbitrarily long patterns.
  if (q?.trim()) filters.searchQuery = q.trim().slice(0, 100);

  // Cursor is encoded as "<ISO>|<uuid>"
  const cursorRaw = pick("cursor");
  let cursor: AdoptionListingCursor | null = null;
  if (cursorRaw) {
    const [iso, id] = cursorRaw.split("|");
    if (iso && id) cursor = { listedAt: iso, id };
  }

  return { filters, cursor };
}

export function buildSearchParams(
  filters: AdoptionListingFilters,
  cursor: AdoptionListingCursor | null,
): URLSearchParams {
  const out = new URLSearchParams();
  if (filters.species) out.set("species", filters.species);
  if (filters.province) out.set("provincia", filters.province);
  if (filters.locality) out.set("localidad", filters.locality);
  if (filters.ageBucket) out.set("edad", filters.ageBucket);
  if (filters.sizeEstimate) out.set("talle", filters.sizeEstimate);
  if (filters.energyLevel) out.set("energia", filters.energyLevel);
  if (filters.goodWithKids) out.set("con_chicos", "true");
  if (filters.goodWithDogs) out.set("con_perros", "true");
  if (filters.goodWithCats) out.set("con_gatos", "true");
  if (filters.needsYard === false) out.set("sin_patio", "true");
  if (filters.hasMicrochip === true) out.set("con_chip", "true");
  if (filters.organizationToken) out.set("org", filters.organizationToken);
  if (filters.searchQuery) out.set("q", filters.searchQuery);
  if (cursor) out.set("cursor", `${cursor.listedAt}|${cursor.id}`);
  return out;
}
