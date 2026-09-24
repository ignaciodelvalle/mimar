// searchBookableOfferings / readBookableOffering — the READ half of "reservar un
// turno", copied as a negation of the web's own two pages rather than re-derived.
//
// WHY THE SEARCH AND THE BOOKING ARE ONE WORK UNIT
// ---------------------------------------------------------------------------
// A search that cannot book lists slots nobody can take, and a book with no
// search is unreachable. The board says so and this module is the half that
// makes the other half addressable: everything `bookSlotWriter` will refuse is
// decided HERE first, so a client never draws a control the write throws away.
//
// WHOSE GUARDS THESE ARE — THE CALL SITES, NAMED
// ---------------------------------------------------------------------------
// Every predicate below is the negation of a line in one of three web files, and
// not one of them was re-derived. This repo has three times found two rules where
// it believed it had one, so the citations are part of the code:
//
//   · `app/(app)/turnos/buscar/page.tsx:103-120` — the OFFERING filter:
//     `service_kind`, `status = 'approved'`, province equality, LOCALITY BY
//     SUBSUMPTION (never plain equality — see below), and the free-only toggle.
//   · `app/(app)/turnos/buscar/page.tsx:145-156` and
//     `[offeringToken]/page.tsx:54-70` — the SLOT filter: `status = 'open'`,
//     inside the window, and `bookings_count < capacity`. The two windows differ
//     on purpose (7 days on the list, 60 on the detail) and both are preserved.
//   · `.../reservar/[slotId]/page.tsx:64-71` — WHICH PETS may be offered: an
//     ACTIVE ownership row of any role, `pets.status <> 'deceased'`, and
//     `pets.deleted_at IS NULL`.
//   · `app/actions/booking.ts:51-79` — the same two pet rules again, as the
//     WRITE's guard rather than as a picker filter. That duplication is the
//     web's own and it is deliberate there ("a tab opened before the death was
//     recorded … reach this action with a petId the selector would no longer
//     show"); this module is the picker half, and `bookSlotAction`'s successor
//     on the bearer door keeps the writer half.
//
// LOCALITY IS SUBSUMPTION-AWARE AND THAT IS NOT A DETAIL
// ---------------------------------------------------------------------------
// An offering tagged to a WHOLE PROVINCE — CABA's INDEC name, or the `""`
// sentinel elsewhere — must be reachable from a barrio search, or the campaign
// covering all of CABA is invisible to every citizen in it. That was live on
// staging on 2026-08-13. `localitiesCoveringSearch` is the one place the rule
// lives; this module calls it and adds nothing.
//
// ART. 16 (Ley 25.326): the pet list joins `pets.deleted_at IS NULL`. An erased
// animal leaves a surviving foster/co-owner ownership row behind, so without it a
// third party would be offered an erased pet to book a turno for.
//
// NO RAW `Date` GOES INTO A `sql` FRAGMENT. `__tests__/no-raw-date-in-sql.test.ts`
// scans `src/` for exactly that, and the crash it prevents took down three admin
// pages. Every window bound below is a typed `gte`/`lte`, which binds a `Date`
// correctly; the only `sql` fragments here compare two COLUMNS, which the driver
// serialises as identifiers.

import { type SQL, and, asc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";

import {
  appointments,
  db,
  organizations,
  ownerships,
  pets,
  profiles,
  serviceOfferings,
  timeSlots,
} from "@/db";
import {
  localitiesCoveringSearch,
  offeringCoverageLabel,
} from "@/lib/domain/jurisdiction-canonical";
import { slotRuleIsLive } from "@/lib/infra/slot-rule-liveness";
import { findServiceKind } from "@/lib/reference/service-kinds";

/**
 * How far ahead the LIST looks: seven days, the web's own window
 * (`buscar/page.tsx:97`). It is what makes the "N turnos disponibles en 7 días"
 * line on each result mean something.
 */
export const SEARCH_LIST_WINDOW_DAYS = 7;

/**
 * How far ahead ONE offering's slot grid looks: sixty days, the web's own window
 * (`buscar/[offeringToken]/page.tsx:52`). Wider than the list on purpose — the
 * list is "is anybody offering this near me", the grid is "when can I go".
 */
export const OFFERING_SLOT_WINDOW_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Who is providing the service, resolved from the `provider_xor` pair.
 *
 * ALMOST the shape `listAppointmentsForUser` returns — and the difference is
 * the point, not an accident (PO decision 2026-09-01). A turno you ALREADY
 * HOLD carries the professional's phone, because you need to call the person
 * you are about to see. A SEARCH RESULT reaches any authenticated caller with
 * no relationship to the offering, so the professional variant here carries
 * NO phone: `profiles.phone` is a personal number, and the two web pages this
 * module's header negates line by line never selected it — one with an
 * explicit comment, after the 2026-08-13 incident. The earlier "deliberately
 * the same type" rationale was about RENDERING convenience, which is true and
 * was never an authorization argument; the widening rode in on it. The
 * organization's phone stays: it is the clinic's public number, with precedent
 * (`lib/infra/org-public-profile.ts`).
 */
export type BookableProvider =
  | { kind: "organization"; displayName: string; phone: string | null; locality: string | null }
  | {
      kind: "professional";
      displayName: string;
      matriculaNumber: string | null;
    }
  | { kind: "unknown" };

/** One result of the search: an offering that has at least one takeable slot. */
export type BookableOfferingSummary = {
  offeringToken: string;
  displayName: string;
  description: string | null;
  serviceKind: string;
  serviceKindLabel: string | null;
  provider: BookableProvider;
  durationMinutes: number;
  priceArs: number | null;
  /** The offering's OWN coverage, never the organisation's address. See the header. */
  coverageLabel: string | null;
  /** How many takeable slots fall inside `SEARCH_LIST_WINDOW_DAYS`. Always ≥ 1. */
  slotsInWindow: number;
  /** The soonest of them. Non-null by construction — a summary with none is dropped. */
  nextSlotAt: Date;
};

/** One slot a person can actually take. */
export type BookableSlot = {
  slotId: string;
  startsAt: Date;
  endsAt: Date;
  /** `capacity - bookings_count` at read time. Always ≥ 1. */
  placesLeft: number;
};

/**
 * A pet the caller may book WITH, and whether this offering will take it.
 *
 * `canBook` IS THE SERVER'S and a client must not derive it from `blockedReason`
 * being absent — that is the same rule `canClaim` states on the claim door. The
 * reason it matters here is `already_booked`: the campaign-level identity guard
 * lives inside `bookSlotWriter`'s transaction (`book-slot.ts:123-136`), keyed on
 * (pet, OFFERING) rather than (pet, slot), so a client deriving eligibility from
 * the slot list alone would draw a button for a pet the write refuses.
 */
export type BookablePet = {
  publicToken: string;
  name: string;
  canBook: boolean;
  /**
   * Why not, when `canBook` is false. `null` when it is true.
   *
   * A CLOSED VOCABULARY rather than prose, so the client owns the sentence. Only
   * one member today; a deceased or erased animal is not in this list AT ALL
   * (the query drops it), which is a different answer from "listed and refused"
   * and the right one — a memorial row on a booking form is not an affordance.
   */
  blockedReason: "already_booked_in_offering" | null;
};

/** One offering, with everything the confirm screen needs. */
export type BookableOfferingDetail = {
  offering: BookableOfferingSummary;
  slots: BookableSlot[];
  pets: BookablePet[];
};

/**
 * `price_ars` as a number, or `null`.
 *
 * `numeric(10,2)` arrives as a STRING from the driver, and `null` means GRATUITO:
 * `Number(null)` is `0`, and a free campaign rendered as "$0" is a different
 * claim. Same function, same reason, as `list-appointments-for-user.ts`.
 */
function priceToNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

type ProviderColumns = {
  organizationId: string | null;
  orgDisplayName: string | null;
  orgPhone: string | null;
  jurisdictionLocality: string | null;
  providerDisplayName: string | null;
  providerMatricula: string | null;
};

/**
 * The provider, from the XOR pair.
 *
 * THE DISCRIMINATOR IS THE OFFERING'S `organization_id` HERE, not an
 * appointment's. `list-appointments-for-user.ts` reads the column denormalised
 * onto the booking, because that is what the row says about who it was booked
 * with; nothing is booked yet, so the offering's own column is the only one there
 * is. The two are the same value at insert time (`book-slot.ts:156-166`).
 *
 * `locality` IS THE OFFERING'S, NOT THE ORGANISATION'S — fixed 2026-09-04,
 * same shape as `list-appointments-for-user.ts`'s `resolveProvider`. This one
 * reused `organizations.jurisdiction_locality` (`OFFERING_COLUMNS.orgLocality`,
 * now removed) even though `jurisdictionLocality` — the offering's own column,
 * already selected here for `coverageLabel` — was sitting right next to it.
 * Same root cause as the 2026-08-13 `coverageLabel` incident this file's header
 * already cites: an org running an offering away from its own registered
 * address must show THAT place, not its home address.
 */
// Exported for the PII fence (__tests__/appointment-search-provider-pii.test.ts).
export function resolveProvider(row: ProviderColumns): BookableProvider {
  if (row.organizationId !== null && row.orgDisplayName !== null) {
    return {
      kind: "organization",
      displayName: row.orgDisplayName,
      phone: row.orgPhone,
      locality: row.jurisdictionLocality,
    };
  }
  if (row.organizationId === null && row.providerDisplayName !== null) {
    // No phone, and not by omission — see the BookableProvider docblock. The
    // column is not even selected (OFFERING_COLUMNS), so re-adding it here
    // would fail to compile before it could leak.
    return {
      kind: "professional",
      displayName: row.providerDisplayName,
      matriculaNumber: row.providerMatricula,
    };
  }
  return { kind: "unknown" };
}

/**
 * `bookings_count < capacity`, as a fragment.
 *
 * A COLUMN-TO-COLUMN comparison, so it cannot be a typed `lt` (which takes a
 * value) and it interpolates no `Date` — the driver serialises both sides as
 * identifiers. It is the same predicate the DB CHECK `slot_bookings_within_capacity`
 * enforces from the other side, and the same one both web pages spell inline.
 */
function hasRoom(): SQL {
  return sql`${timeSlots.bookingsCount} < ${timeSlots.capacity}`;
}

/**
 * The OFFERING filter, as the web builds it.
 *
 * `status = 'approved'` IS AN AUTHORIZATION PREDICATE AND NOT A TIDINESS ONE.
 * `bookSlotWriter` re-checks it inside the booking transaction (SC3,
 * `book-slot.ts:144-155`) precisely because a pre-materialised slot of a paused
 * offering is otherwise bookable out of band. Dropping it here would make this
 * module advertise slots the writer refuses.
 */
function offeringFilter(args: {
  serviceKind: string;
  province: string | null;
  locality: string | null;
  freeOnly: boolean;
}): SQL[] {
  const conditions: SQL[] = [
    eq(serviceOfferings.serviceKind, args.serviceKind),
    eq(serviceOfferings.status, "approved"),
  ];
  if (args.province) {
    conditions.push(eq(serviceOfferings.jurisdictionProvince, args.province));
  }
  // SUBSUMPTION, never equality — see the header. A province-wide offering has to
  // answer a barrio search.
  if (args.locality) {
    conditions.push(
      inArray(
        serviceOfferings.jurisdictionLocality,
        localitiesCoveringSearch(args.province ?? "", args.locality),
      ),
    );
  }
  if (args.freeOnly) {
    conditions.push(isNull(serviceOfferings.priceArs));
  }
  return conditions;
}

const OFFERING_COLUMNS = {
  offeringToken: serviceOfferings.publicToken,
  offeringId: serviceOfferings.id,
  displayName: serviceOfferings.displayName,
  description: serviceOfferings.description,
  serviceKind: serviceOfferings.serviceKind,
  durationMinutes: serviceOfferings.durationMinutes,
  priceArs: serviceOfferings.priceArs,
  jurisdictionProvince: serviceOfferings.jurisdictionProvince,
  jurisdictionLocality: serviceOfferings.jurisdictionLocality,
  organizationId: serviceOfferings.organizationId,
  orgDisplayName: organizations.displayName,
  orgPhone: organizations.phone,
  // NOTE: no `orgLocality` column here on purpose. `resolveProvider` reads
  // `jurisdictionLocality` above — the offering's own — for `provider.locality`
  // too; a second selection of `organizations.jurisdiction_locality` would only
  // recreate the column the 2026-09-04 fix removed.
  providerDisplayName: profiles.displayName,
  providerMatricula: profiles.matriculaNumber,
  // profiles.phone DELIBERATELY ABSENT — PO decision 2026-09-01, see
  // BookableProvider. The org's phone above has a public precedent; the
  // professional's personal number does not cross on a national search.
} as const;

type OfferingRow = {
  offeringToken: string;
  offeringId: string;
  displayName: string;
  description: string | null;
  serviceKind: string;
  durationMinutes: number;
  priceArs: unknown;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
} & ProviderColumns;

function toSummary(
  row: OfferingRow,
  counts: { slotsInWindow: number; nextSlotAt: Date },
): BookableOfferingSummary {
  return {
    offeringToken: row.offeringToken,
    displayName: row.displayName,
    description: row.description,
    serviceKind: row.serviceKind,
    serviceKindLabel: findServiceKind(row.serviceKind)?.label ?? null,
    provider: resolveProvider(row),
    durationMinutes: row.durationMinutes,
    priceArs: priceToNumber(row.priceArs),
    // The OFFERING's coverage. The detail page printed the ORGANISATION's
    // locality here on 2026-08-13 while the search matched the offering's, so the
    // label named a place the search rejects.
    coverageLabel: offeringCoverageLabel(row.jurisdictionProvince, row.jurisdictionLocality),
    slotsInWindow: counts.slotsInWindow,
    nextSlotAt: counts.nextSlotAt,
  };
}

/**
 * Every offering of one service kind, near a place, with at least one takeable
 * slot inside the next seven days.
 *
 * AN OFFERING WITH NO TAKEABLE SLOT IS DROPPED, not returned with a zero. That is
 * the web's own `offeringsWithSlots` filter, and it is what makes every row on
 * the screen a row somebody can act on.
 *
 * `fromDate` NEVER MOVES THE WINDOW BACKWARDS. The floor is `max(now, fromDate)`,
 * so a client asking for last Tuesday gets today — a past slot is not bookable and
 * the writer refuses it anyway.
 */
export async function searchBookableOfferings(args: {
  serviceKind: string;
  province: string | null;
  locality: string | null;
  fromDate: Date | null;
  freeOnly: boolean;
  now: Date;
}): Promise<BookableOfferingSummary[]> {
  const windowStart =
    args.fromDate && args.fromDate.getTime() > args.now.getTime() ? args.fromDate : args.now;
  const windowEnd = new Date(args.now.getTime() + SEARCH_LIST_WINDOW_DAYS * DAY_MS);

  const offeringRows = (await db
    .select(OFFERING_COLUMNS)
    .from(serviceOfferings)
    .leftJoin(organizations, eq(organizations.id, serviceOfferings.organizationId))
    .leftJoin(profiles, eq(profiles.id, serviceOfferings.providerUserId))
    .where(and(...offeringFilter(args)))) as OfferingRow[];

  if (offeringRows.length === 0) return [];

  // ONE query for every offering's slots, not one per offering. `inArray` binds
  // the ids as parameters; the web builds `ARRAY[...]::uuid[]` by string
  // interpolation at `buscar/page.tsx:150`, which is safe only because the ids
  // came out of the previous SELECT — a shape not worth copying.
  const slotRows = await db
    .select({
      serviceOfferingId: timeSlots.serviceOfferingId,
      startsAt: timeSlots.startsAt,
    })
    .from(timeSlots)
    .where(
      and(
        inArray(
          timeSlots.serviceOfferingId,
          offeringRows.map((r) => r.offeringId),
        ),
        eq(timeSlots.status, "open"),
        slotRuleIsLive(),
        gte(timeSlots.startsAt, windowStart),
        lte(timeSlots.startsAt, windowEnd),
        hasRoom(),
      ),
    )
    .orderBy(asc(timeSlots.startsAt));

  const byOffering = new Map<string, { slotsInWindow: number; nextSlotAt: Date }>();
  for (const slot of slotRows) {
    const seen = byOffering.get(slot.serviceOfferingId);
    // Rows arrive soonest-first, so the FIRST one for an offering is its next.
    if (seen) seen.slotsInWindow += 1;
    else byOffering.set(slot.serviceOfferingId, { slotsInWindow: 1, nextSlotAt: slot.startsAt });
  }

  const summaries: BookableOfferingSummary[] = [];
  for (const row of offeringRows) {
    const counts = byOffering.get(row.offeringId);
    if (!counts) continue;
    summaries.push(toSummary(row, counts));
  }

  // SOONEST FIRST. The web renders offerings in whatever order Postgres returns
  // them, which on a screen answering "when can I take my animal" is no order at
  // all. The next available turno is the answer somebody opened this with.
  return summaries.sort((a, b) => a.nextSlotAt.getTime() - b.nextSlotAt.getTime());
}

/**
 * One offering by its public token, its slot grid, and which of the caller's pets
 * may take one.
 *
 * ANSWERS `null` FOR AN OFFERING THAT IS NOT APPROVED, exactly as the web's page
 * answers `notFound()` for one (`[offeringToken]/page.tsx:43`). A pending or
 * archived offering must not be distinguishable from a token that names nothing.
 */
export async function readBookableOffering(args: {
  offeringToken: string;
  userId: string;
  now: Date;
}): Promise<BookableOfferingDetail | null> {
  const [row] = (await db
    .select(OFFERING_COLUMNS)
    .from(serviceOfferings)
    .leftJoin(organizations, eq(organizations.id, serviceOfferings.organizationId))
    .leftJoin(profiles, eq(profiles.id, serviceOfferings.providerUserId))
    .where(
      and(
        eq(serviceOfferings.publicToken, args.offeringToken),
        eq(serviceOfferings.status, "approved"),
      ),
    )
    .limit(1)) as OfferingRow[];

  if (!row) return null;

  const windowEnd = new Date(args.now.getTime() + OFFERING_SLOT_WINDOW_DAYS * DAY_MS);

  const slotRows = await db
    .select({
      slotId: timeSlots.id,
      startsAt: timeSlots.startsAt,
      endsAt: timeSlots.endsAt,
      capacity: timeSlots.capacity,
      bookingsCount: timeSlots.bookingsCount,
    })
    .from(timeSlots)
    .where(
      and(
        eq(timeSlots.serviceOfferingId, row.offeringId),
        eq(timeSlots.status, "open"),
        slotRuleIsLive(),
        gte(timeSlots.startsAt, args.now),
        lte(timeSlots.startsAt, windowEnd),
        hasRoom(),
      ),
    )
    .orderBy(asc(timeSlots.startsAt));

  const slots: BookableSlot[] = slotRows.map((slot) => ({
    slotId: slot.slotId,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    placesLeft: slot.capacity - slot.bookingsCount,
  }));

  return {
    offering: toSummary(row, {
      // The SUMMARY's counts describe the LIST's seven-day window and this is the
      // sixty-day grid, so they are recomputed against the same window the grid
      // uses rather than carried over. A summary saying "3 en 7 días" beside a
      // grid of forty is two numbers about one thing.
      slotsInWindow: slots.length,
      nextSlotAt: slots[0]?.startsAt ?? args.now,
    }),
    slots,
    pets: await listBookablePets({ offeringId: row.offeringId, userId: args.userId }),
  };
}

/**
 * The caller's pets, and whether THIS offering will take each one.
 *
 * THREE FILTERS, ALL THE WEB'S, and none of them re-derived — see the header for
 * the call sites. Active ownership of ANY role (a foster books under their own
 * id and the turno is theirs), not deceased, not erased.
 *
 * The FOURTH rule is not a filter but a flag: `bookSlotWriter` refuses a second
 * CONFIRMED appointment for the same (pet, offering) pair, and that guard exists
 * because the per-slot one let the same animal take the 08:00 AND the 08:15 of one
 * free campaign — N slots, N eaten places (QA A3, 2026-08-13). Carrying it as
 * `blockedReason` rather than dropping the pet is deliberate: "Pampa ya tiene un
 * turno en esta campaña" is information, where a silently missing animal reads as
 * a bug.
 */
async function listBookablePets(args: {
  offeringId: string;
  userId: string;
}): Promise<BookablePet[]> {
  const rows = await db
    .select({
      publicToken: pets.publicToken,
      name: pets.name,
      // A LEFT JOIN rather than a second query: the pair is one fact about one
      // row, and two round trips would leave a window in which the answer changed
      // between them.
      bookedAppointmentId: appointments.id,
    })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .leftJoin(
      appointments,
      and(
        eq(appointments.petId, pets.id),
        eq(appointments.serviceOfferingId, args.offeringId),
        eq(appointments.status, "confirmed"),
      ),
    )
    .where(
      and(
        eq(ownerships.ownerUserId, args.userId),
        isNull(ownerships.endedAt),
        ne(pets.status, "deceased"),
        // Art. 16 (Ley 25.326). See the header: the erasure leaves a foster or
        // co-owner row standing on the soft-deleted animal.
        isNull(pets.deletedAt),
      ),
    )
    .orderBy(asc(pets.name));

  return rows.map((row) => ({
    publicToken: row.publicToken,
    name: row.name,
    canBook: row.bookedAppointmentId === null,
    blockedReason: row.bookedAppointmentId === null ? null : "already_booked_in_offering",
  }));
}
