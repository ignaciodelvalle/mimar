// Adoption listing DB query — split out from `lib/adoption-listing.ts`
// so that the shared module (catalogs, types, codecs) stays free of
// `db` imports and can be safely consumed by client components like
// `AdoptionFiltersBar.tsx` and `AdoptionListingForm.tsx` without
// dragging the `postgres` driver into the client bundle.
//
// Server callers (page.tsx, server actions, tests) import the query
// from here; everything else continues to import from
// `@/lib/adoption-listing`.

import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";

import { attachments, db, organizations, ownerships, pets } from "@/db";
import { likeContains } from "@/lib/utils/like-helpers";

import { livesWithFamilyUnder } from "../domain/listing-rules";
import { listOpenSponsorships } from "./rehome-sponsorship-writer";

import type {
  AdoptionListingCursor,
  AdoptionListingFilters,
  AdoptionListingItem,
} from "@/lib/infra/adoption-listing";

const DEFAULT_PAGE_SIZE = 24;

export async function queryAdoptionListing(
  filters: AdoptionListingFilters,
  cursor: AdoptionListingCursor | null,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<{ items: AdoptionListingItem[]; nextCursor: AdoptionListingCursor | null }> {
  const conditions = [
    // PO-4 — erasure (Ley 25.326 art. 16) sets `pets.deleted_at` and leaves the
    // row so the spine survives, and /adoptar/{token} then 404s. Without this
    // the listing kept rendering the card and `app/sitemap.ts` — which builds
    // its `/adoptar/{token}` entries from THIS function's results — kept
    // advertising the dead URL, making "erased" distinguishable from "never
    // existed". Same filter, same reason, as queryLostListing.
    isNull(pets.deletedAt),
    // Seeded (synthetic) pets are never offered to the public: a real
    // application on one would be a real act the govt queues then hide
    // (lib/domain/synthetic-pet.ts). The sitemap inherits this.
    isNull(pets.seedTag),
    isNotNull(pets.adoptionListedAt),
    isNull(pets.adoptionListingPausedAt),

    // D18 — pet status guard. We can't use `notInArray(pets.status, [...])`
    // because pets.status is a `text` column with no enum in Drizzle's eyes;
    // a pair of `ne` is equivalent and avoids the type cast.
    ne(pets.status, "deceased"),
    ne(pets.status, "lost"),

    // D19 — cross-spec with foster-volunteers v1.4 — only marked apta.
    eq(pets.adoptionEligible, true),

    // D20 — cross-spec with custody-disputes — must not be locked.
    or(isNull(pets.inCustodyDispute), eq(pets.inCustodyDispute, false)),

    // D21 — cross-spec with bite-rabies-observation — exclude the
    // 10-day quarantine window. The real enum value is "in_progress"
    // (the spec draft said "active"; aligning here with the actual
    // CHECK constraint from migration 0021).
    or(isNull(pets.rabiesObservationStatus), ne(pets.rabiesObservationStatus, "in_progress")),

    // Custody by a verified shelter / rescue_network. Active ownership row.
    //
    // "CUSTODIA" MEANS TWO THINGS HERE (rehome-by-titular, design R4): this
    // row is also what a rehome SPONSORSHIP gives the org while the animal
    // keeps living with its family. That is the PO-accepted overload that
    // keeps this predicate untouched (design R5: it is duplicated in four
    // places and must not drift). Where the animal lives is said by
    // `livesWithFamily` below, decided on the spine, never by this row.
    isNull(ownerships.endedAt),
    eq(ownerships.role, "shelter_custody"),
    eq(organizations.verified, true),
    inArray(organizations.orgType, ["shelter", "rescue_network"]),
  ];

  // Optional filters.
  if (filters.species) conditions.push(eq(pets.species, filters.species));
  if (filters.province) conditions.push(eq(pets.jurisdictionProvince, filters.province));
  if (filters.locality) conditions.push(eq(pets.jurisdictionLocality, filters.locality));
  if (filters.ageBucket) conditions.push(eq(pets.adoptionAgeBucket, filters.ageBucket));
  if (filters.sizeEstimate) conditions.push(eq(pets.adoptionSizeEstimate, filters.sizeEstimate));
  if (filters.energyLevel) conditions.push(eq(pets.adoptionEnergyLevel, filters.energyLevel));
  if (filters.goodWithKids === true) conditions.push(eq(pets.adoptionGoodWithKids, true));
  if (filters.goodWithDogs === true) conditions.push(eq(pets.adoptionGoodWithDogs, true));
  if (filters.goodWithCats === true) conditions.push(eq(pets.adoptionGoodWithCats, true));
  // needsYard=false means "available WITHOUT yard requirement" — null is
  // tolerated because "we don't know" doesn't disqualify the pet.
  if (filters.needsYard === false) {
    conditions.push(or(eq(pets.adoptionNeedsYard, false), isNull(pets.adoptionNeedsYard)));
  }
  // hasMicrochip filter: use EXISTS against the canonical pet_identifications
  // table (same pattern as the sterilized EXISTS above — mirrors ARCH-M idiom).
  if (filters.hasMicrochip === true) {
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM pet_identifications pi
        WHERE pi.pet_id = ${pets.id}
          AND pi.kind = 'microchip_iso'
          AND pi.status = 'active'
      )`,
    );
  }
  if (filters.hasMicrochip === false) {
    conditions.push(
      sql`NOT EXISTS (
        SELECT 1 FROM pet_identifications pi
        WHERE pi.pet_id = ${pets.id}
          AND pi.kind = 'microchip_iso'
          AND pi.status = 'active'
      )`,
    );
  }
  if (filters.organizationToken) {
    conditions.push(eq(organizations.publicToken, filters.organizationToken));
  }
  if (filters.searchQuery) {
    const pattern = likeContains(filters.searchQuery);
    // unaccent() on both sides: "labrador" finds "Labràdor", etc.
    // likeContains() escapes % and _ to prevent wildcard injection.
    conditions.push(
      or(
        sql`unaccent(${pets.name}) ILIKE unaccent(${pattern}) ESCAPE '\'`,
        sql`unaccent(${pets.breed}) ILIKE unaccent(${pattern}) ESCAPE '\'`,
      ),
    );
  }

  // Keyset cursor.
  if (cursor) {
    const cursorDate = new Date(cursor.listedAt);
    conditions.push(
      or(
        lt(pets.adoptionListedAt, cursorDate),
        and(eq(pets.adoptionListedAt, cursorDate), lt(pets.id, cursor.id)),
      ),
    );
  }

  const rows = await db
    .select({
      petId: pets.id,
      petPublicToken: pets.publicToken,
      name: pets.name,
      species: pets.species,
      breed: pets.breed,
      sex: pets.sex,
      color: pets.color,
      primaryPhotoId: pets.primaryPhotoId,
      primaryPhotoStoragePath: attachments.storagePath,
      jurisdictionProvince: pets.jurisdictionProvince,
      jurisdictionLocality: pets.jurisdictionLocality,
      // hasMicrochip: EXISTS, never the code. The card renders a "Con chip"
      // badge — a boolean — and /adoptar is unauthenticated, so selecting the
      // 15-digit canonical value put every listed pet's chip one `"use client"`
      // away from the public RSC payload. Same standard queryLostListing's
      // Item-27 location split already applies: don't fetch PII you only need
      // to test for presence, rather than fetch it and redact in JS.
      hasMicrochip: sql<boolean>`EXISTS (
        SELECT 1 FROM pet_identifications pi
        WHERE pi.pet_id = ${pets.id}
          AND pi.kind = 'microchip_iso'
          AND pi.status = 'active'
      )`,
      adoptionListedAt: pets.adoptionListedAt,
      adoptionStory: pets.adoptionStory,
      adoptionRequirements: pets.adoptionRequirements,
      adoptionEnergyLevel: pets.adoptionEnergyLevel,
      adoptionSizeEstimate: pets.adoptionSizeEstimate,
      adoptionAgeBucket: pets.adoptionAgeBucket,
      adoptionGoodWithKids: pets.adoptionGoodWithKids,
      adoptionGoodWithDogs: pets.adoptionGoodWithDogs,
      adoptionGoodWithCats: pets.adoptionGoodWithCats,
      adoptionNeedsYard: pets.adoptionNeedsYard,
      adoptionFeeArs: pets.adoptionFeeArs,
      orgId: organizations.id,
      orgPublicToken: organizations.publicToken,
      orgDisplayName: organizations.displayName,
      // organizations doesn't have an avatar column today; expose null and
      // a future spec can backfill without changing this interface.
      orgAvatarUrl: sql<string | null>`NULL`,
      isSterilized: sql<boolean>`EXISTS (
        SELECT 1 FROM pet_events e
        WHERE e.pet_id = ${pets.id}
          AND e.event_type = 'sterilization_performed'
      )`,
    })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .innerJoin(organizations, eq(organizations.id, ownerships.ownerOrganizationId))
    .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
    .where(and(...conditions))
    .orderBy(desc(pets.adoptionListedAt), desc(pets.id))
    .limit(pageSize + 1);

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  // Where the animal lives (spec REQ-12). A second, page-sized query on the
  // spine rather than a fifth copy of the catalog predicate (design R5): the
  // listing predicate is untouched, and "sponsored" is decided the way every
  // other surface decides it — an unmatched `rehome_sponsorship_started`,
  // belonging to THIS row's custodian (`livesWithFamilyUnder`, the one
  // predicate the public ficha uses too).
  const sponsored = await listOpenSponsorships(
    page.map((r) => r.petId),
    db,
  );
  const items: AdoptionListingItem[] = page.map((r) => ({
    ...(r as Omit<AdoptionListingItem, "livesWithFamily">),
    livesWithFamily: livesWithFamilyUnder(sponsored.get(r.petId), r.orgId),
  }));
  const last = items.at(-1);
  const nextCursor: AdoptionListingCursor | null =
    hasMore && last?.adoptionListedAt
      ? { listedAt: last.adoptionListedAt.toISOString(), id: last.petId }
      : null;

  return { items, nextCursor };
}
