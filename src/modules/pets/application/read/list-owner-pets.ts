// The owner's pet list: ONE door, two renderers.
//
// WHY IT LEFT THE PAGE (native-readiness WU-B, item 2)
// ---------------------------------------------------------------------------
// This query lived inline in `app/(app)/mis-mascotas/page.tsx`, as two entries
// of an eight-way `Promise.all` — the rows, and a COUNT over the same predicate
// so the 200-cap notice could read honestly. Everything about it that is a
// DECISION was expressed as drizzle sitting in the middle of a React server
// component: which pets count as the caller's (an open `ownerships` row, any
// role), how a name search escapes its wildcards, which columns are worth
// transferring, what happens past the cap.
//
// So the only way to ask "what pets does this person have?" was to render HTML
// and read it back — which is exactly what `GET /api/v1/me/pets` cannot do. The
// alternative to extracting it was a route handler with a second copy of the
// predicate, and a second copy of "which pets are yours" is how a native list
// eventually shows a pet the web list does not, or keeps showing one a completed
// transfer took away. `lookup-public-credential.ts` set this precedent for the
// public credential and the reasoning is the same one.
//
// WHAT STAYED BEHIND, deliberately: the compliance fan-out, the urgency sort,
// the inbox aggregates. None of them is "the caller's pets" — they are what the
// WEB INDEX draws on top, each with its own bounded load and its own soft
// failure. Pulling them in would make this door answer a question the API does
// not ask and cannot afford.
//
// WHY `deps` EXISTS: the two collaborators are injectable so the CAP and the
// truncation arithmetic are testable without Postgres. "Did the caller get 200
// of 340, and did the payload say so" is the property that matters, and proving
// it should not require seeding 340 pets.

import { attachments, db, ownerships, pets } from "@/db";
import { PET_CARD_PHOTO_SELECT, PET_CARD_SELECT } from "@/lib/infra/pet-projections";
import { keysetWhere } from "@/lib/utils/keyset-pagination";
import { likeContains } from "@/lib/utils/like-helpers";
import { type SQL, and, count, desc, eq, isNull, sql } from "drizzle-orm";

/**
 * Maximum rows returned in one call.
 *
 * Owners with thousands of pets (high-volume rescue networks / shelters) would
 * otherwise produce an enormous DOM on the web and an enormous JSON body on the
 * API, and load every one of those rows into server memory to do it. The cap
 * bounds the listing; the name search (server-side ILIKE, same cap) is how an
 * owner narrows past it. Full pagination is tracked as a follow-up.
 *
 * It lives HERE, with the query it bounds, so the API inherits the same number
 * as the page instead of copying it — and so `total` and `truncated` are derived
 * from something real rather than from two constants that agree today.
 */
export const OWNER_PET_LIST_LIMIT = 200;

/**
 * The query, as a builder, so the row type below can be INFERRED from it.
 *
 * Writing `OwnerPetListRow` by hand would compile and would be wrong the first
 * time a column changed shape: a hand-written `sex: string` silently widens the
 * pet-sex enum, and the web index's typed props would start accepting values the
 * database cannot produce. The type is derived instead, so the projection and
 * its consumers cannot disagree.
 *
 * The ORDER BY is not cosmetic: WHICH rows survive the cap must not be DB-order
 * luck. Newest first, the same order `fetchPetsForOwner` uses. The web index
 * re-sorts what it gets by urgency for display; the API returns this order,
 * because a client that wants a different one has the whole page in hand.
 *
 * `created_at` ALONE IS NOT AN ORDER. It is `now()`, the transaction's start,
 * so every pet one transaction writes shares it exactly — and the nightly e2e
 * writes more than 200 that way. With nothing after it, Postgres broke the tie
 * differently per execution and the capped page was a different SUBSET on each
 * load. `pets.id` then `ownerships.id` make the key unique (a person could in
 * principle hold two open roles on one pet), so the page is a function of the
 * data. `__tests__/owner-pet-list-order.test.ts` pins it.
 *
 * `petCreatedAt` RIDES OUTSIDE `PET_CARD_SELECT` (D5, cursor pagination) —
 * every OTHER consumer of that projection has no use for it, and widening a
 * shared projection for one caller's cursor is how a "card" shape drifts into
 * carrying columns nothing on a card shows. It is the keyset's first column,
 * read back so `listOwnerPets` can hand the caller a `nextCursor` built from
 * the LAST row of the page it actually returned — never from a value the
 * caller sent back to it.
 */
function ownerPetRowsQuery(where: SQL | undefined, limit: number) {
  return db
    .select({
      pet: PET_CARD_SELECT,
      photo: PET_CARD_PHOTO_SELECT,
      ownershipRole: ownerships.role,
      petCreatedAt: pets.createdAt,
    })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
    .where(where)
    .orderBy(desc(pets.createdAt), desc(pets.id), desc(ownerships.id))
    .limit(limit);
}

/**
 * One row of the caller's list: the card projection (8 columns of the 68 on
 * `pets`), the primary photo's storage path (null when the join found nothing),
 * the caller's custody role on that pet, and the raw `created_at` the cursor is
 * built from.
 */
export type OwnerPetListRow = Awaited<ReturnType<typeof ownerPetRowsQuery>>[number];

/** A decoded keyset cursor over `(pets.created_at, pets.id)` — see `keyset-pagination.ts`. */
export type OwnerPetListCursor = { ts: string; id: string };

export type OwnerPetList = {
  /** At most `limit` rows, newest registration first. */
  rows: OwnerPetListRow[];
  /**
   * How many pets match, ignoring the cap — the FULL count under the base
   * predicate, not "how many remain after this cursor". Counted under the SAME
   * predicate the rows are (MINUS the cursor condition, which narrows a page,
   * not the set) — including the name filter — so "showing N of M" reads
   * honestly whether or not a search is active. A count over a DIFFERENT
   * predicate is a notice that lies precisely when someone is searching.
   */
  total: number;
  /**
   * The cursor for the NEXT page, or `null` when this page reached the end of
   * the result set (not the cap — the actual end). Built from the last row
   * THIS call returned, per `keyset-pagination.ts`'s contract: the client
   * never constructs one, only echoes back what the server minted.
   */
  nextCursor: OwnerPetListCursor | null;
};

export type ListOwnerPetsDeps = {
  fetchRows: (where: SQL | undefined, limit: number) => Promise<OwnerPetListRow[]>;
  countRows: (where: SQL | undefined) => Promise<number>;
};

/**
 * The caller's pets, newest first, capped.
 *
 * SCOPE IS AN OPEN OWNERSHIP ROW, ANY ROLE. Not `role = 'owner'`: a pet held in
 * tránsito by a foster IS in that person's list, and the web index has always
 * shown it (it renders a "tránsito" chip beside it). `endedAt IS NULL` is what
 * makes a completed transfer disappear from the previous holder's list, and it
 * is the only thing that does — so it is not optional, and it is why this
 * predicate is written once.
 *
 * D5 — CURSOR PAGINATION. `cursor` narrows the ROWS predicate only; `total` is
 * still counted under the base predicate (cursor absent), so the "N of M"
 * figure names the whole set on every page, not a shrinking remainder. Rows are
 * fetched `limit + 1` deep so a next page can be detected without a second
 * COUNT — the same trick `listNotificationsForUser` and the adoption catalogue
 * already use.
 *
 * THE CURSOR IS TWO COLUMNS (`created_at`, `pets.id`), NOT THREE. The ORDER BY
 * keeps `ownerships.id` as a third tiebreak for the rare case of one caller
 * holding two open ownership rows on the SAME pet — but a keyset predicate
 * compares row VALUES, and two rows sharing an identical (created_at, pet id)
 * pair are indistinguishable to it regardless of which ownership row backs
 * them. The residual: if a page boundary fell exactly between two such
 * duplicate-pet rows, the second would not reappear on the next page. Accepted
 * rather than solved — it needs both a genuine tie AND a boundary landing
 * inside it, on data this rare — over widening `keyset-pagination.ts`'s shared
 * two-column contract for one caller's edge case.
 */
export async function listOwnerPets(
  input: {
    ownerUserId: string;
    /** Optional case-insensitive name filter. Empty/absent → no filter. */
    query?: string;
    limit?: number;
    /** A decoded keyset cursor, or `null`/absent for the first page. */
    cursor?: OwnerPetListCursor | null;
  },
  deps: ListOwnerPetsDeps = { fetchRows: defaultFetchRows, countRows: defaultCountRows },
): Promise<OwnerPetList> {
  const trimmedQuery = input.query?.trim() ?? "";
  const limit = input.limit ?? OWNER_PET_LIST_LIMIT;
  const cursor = input.cursor ?? null;

  // Server-side name filter with an explicit ESCAPE clause — parity with
  // lib/infra/omnibox-search.ts. `likeContains()` backslash-escapes % and _ in
  // the user input; ESCAPE '\' tells Postgres to treat that backslash as the
  // escape char. drizzle's `ilike()` helper cannot carry an ESCAPE clause, so
  // this is a raw sql predicate. `and()` drops it when the query is empty, so
  // the unfiltered path is byte-identical to having no filter at all.
  const nameFilter = trimmedQuery
    ? sql`${pets.name} ILIKE ${likeContains(trimmedQuery)} ESCAPE '\\'`
    : undefined;

  const baseWhere = and(
    eq(ownerships.ownerUserId, input.ownerUserId),
    isNull(ownerships.endedAt),
    nameFilter,
  );

  // `keysetWhere` returns `undefined` for a null cursor, and `and(baseWhere,
  // undefined)` is `baseWhere` itself — so the first-page predicate stays the
  // SAME object the count runs against, byte-identical to the pre-D5 query.
  const cursorCondition = keysetWhere(pets.createdAt, pets.id, cursor);
  const pagedWhere = cursorCondition ? and(baseWhere, cursorCondition) : baseWhere;

  const [rows, total] = await Promise.all([
    deps.fetchRows(pagedWhere, limit + 1),
    deps.countRows(baseWhere),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = page.at(-1);
  const nextCursor: OwnerPetListCursor | null =
    hasMore && lastRow ? { ts: lastRow.petCreatedAt.toISOString(), id: lastRow.pet.id } : null;

  return { rows: page, total, nextCursor };
}

/** Default row fetch — the builder above, awaited. */
async function defaultFetchRows(where: SQL | undefined, limit: number): Promise<OwnerPetListRow[]> {
  return ownerPetRowsQuery(where, limit);
}

/** Default count, over the SAME predicate as the rows. */
async function defaultCountRows(where: SQL | undefined): Promise<number> {
  const result = await db
    .select({ n: count() })
    .from(ownerships)
    .innerJoin(pets, eq(pets.id, ownerships.petId))
    .where(where);
  return Number(result[0]?.n ?? 0);
}
