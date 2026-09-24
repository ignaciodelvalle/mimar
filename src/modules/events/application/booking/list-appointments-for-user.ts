// listAppointmentsForUser — every turno one person booked, bucketed the way the
// web's `/mis-turnos` buckets them, with the three clock-dependent facts decided
// HERE rather than by whoever renders it.
//
// WHY IT EXISTS SEPARATELY FROM THE PAGE
// ---------------------------------------------------------------------------
// `/mis-turnos/page.tsx` does this query inline and then splits it inline. That
// is fine while there is one consumer; there are now two, and the second is a
// phone, whose clock is not the server's. Every rule that reads `new Date()` —
// which of the three sections a row is in, whether it can still be cancelled,
// whether the check-in QR is still good — has to be settled on the server or it
// is settled by a device that may be days wrong, in the flattering direction.
//
// This module is the single answer. The page's inline SPLIT is migrated onto it
// as of 2026-08-31 — it imports `sectionOf` and no longer carries a predicate of
// its own — while its inline QUERY stays, because pulling the page through this
// whole use-case is a larger change than the bucketing decision was. So the two
// still coexist as queries and no longer as RULES, which is the half that was
// silently disagreeing.
//
// THE ART. 16 GUARD IS NOT OPTIONAL AND IS NOT COSMETIC
// ---------------------------------------------------------------------------
// `bookSlotAction` accepts ANY active ownership role, not just `owner`, so a
// foster or a co-owner books with `appointments.owner_user_id` set to their own
// id. The erasure RPC soft-deletes the `role='owner'` pet and leaves that foster
// ownership — and this appointment — standing. Without `pets.deleted_at IS NULL`
// an erased animal would surface here to a third party who is still live. The
// web's list and its detail page each carry this join for the same reason; this
// is the third copy and the one the phone reads through.

import { and, eq, isNull } from "drizzle-orm";

import { appointments, db, organizations, pets, profiles, serviceOfferings, timeSlots } from "@/db";
import { findServiceKind } from "@/lib/reference/service-kinds";
import type { AppointmentSectionV1, AppointmentStatusV1 } from "@dim/contract/api";

/**
 * Who is providing the service, resolved from the `provider_xor` pair.
 *
 * Mirrors `AppointmentProviderV1` without importing it as the return type, for
 * the reason every other read use-case here keeps its own shape: this is a
 * DOMAIN answer, and the payload module is what turns it into a wire shape. The
 * two are checked against each other by the compiler at the one place they meet.
 */
export type AppointmentProvider =
  | { kind: "organization"; displayName: string; phone: string | null; locality: string | null }
  | {
      kind: "professional";
      displayName: string;
      matriculaNumber: string | null;
      phone: string | null;
    }
  | { kind: "unknown" };

export type AppointmentListItem = {
  appointmentToken: string;
  status: AppointmentStatusV1;
  section: AppointmentSectionV1;
  pet: { publicToken: string; name: string };
  offeringName: string;
  serviceKind: string;
  serviceKindLabel: string | null;
  provider: AppointmentProvider;
  durationMinutes: number;
  priceArs: number | null;
  startsAt: Date;
  endsAt: Date;
  canCancel: boolean;
  canCheckIn: boolean;
};

export type AppointmentsForUser = {
  upcoming: AppointmentListItem[];
  past: AppointmentListItem[];
  cancelled: AppointmentListItem[];
};

/**
 * The five statuses the `appointment_status_valid` CHECK admits.
 *
 * A ROW WHOSE STATUS IS NONE OF THEM IS DROPPED, not defaulted. The constraint
 * makes that unreachable today, and if it ever becomes reachable — a migration
 * widening the CHECK, a direct write — the honest answer is to say nothing about
 * a row we cannot classify rather than to bucket it as `confirmed`, which is
 * what the web's detail page did until the state-honesty audit caught it
 * rendering an unknown status with the green "Confirmado" badge.
 */
const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  "confirmed",
  "attended",
  "no_show",
  "cancelled_by_owner",
  "cancelled_by_org",
]);

/**
 * Narrow a status column to the union, or say it is not one.
 *
 * EXPORTED ALONGSIDE `sectionOf` BECAUSE THE TWO TRAVEL TOGETHER. Drizzle types
 * `appointments.status` as `string` — the CHECK constraint is a database fact the
 * compiler cannot see — so every caller holding raw rows needs this before it can
 * ask `sectionOf` anything. Handing out the section rule without the narrowing
 * that feeds it is how the second caller ends up writing its own `as`.
 */
export function isKnownAppointmentStatus(status: string): status is AppointmentStatusV1 {
  return KNOWN_STATUSES.has(status);
}

/**
 * `price_ars` as a number, or `null`.
 *
 * `numeric(10,2)` arrives as a STRING from the driver. `null` means gratuito and
 * must survive as `null` — `Number(null)` is `0`, and a free campaign rendered as
 * "$0" is a different claim from "Gratuito".
 */
function priceToNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Which section a row belongs to, by the SERVER'S clock.
 *
 * IT WAS A FIX RATHER THAN A PORT, AND THE WEB HAS NOW BEEN BROUGHT ONTO IT.
 * `/mis-turnos/page.tsx` used to bucket on `starts_at >= now`, so a turno that
 * was HAPPENING RIGHT NOW left "Próximos" the instant it began — while the detail
 * page kept offering its check-in QR until `ends_at`. The result on the web was a
 * person standing at the clinic desk five minutes late, looking for their turno
 * under "Próximos", and finding it filed under "Pasados". The QR they needed was
 * one tap inside a row they had stopped looking for.
 *
 * So `upcoming` closes at `ends_at` here, which makes `section === "upcoming"`
 * and `canCheckIn` agree for every confirmed row: while the QR is good, the turno
 * is where somebody would go looking for it. The cost is that a turno stays in
 * "Próximos" for its own duration after it started — at most 90 minutes for the
 * longest service in the catalogue — and `canCancel` says plainly that it can no
 * longer be cancelled. That is the honest state of a consultation in progress.
 *
 * THE DIVERGENCE IS CLOSED (PO, 2026-08-31), and it was closed by DELETING the
 * second copy rather than by syncing two. `app/(app)/mis-turnos/page.tsx` had
 * this predicate inline and bucketed on `startsAt`; it now imports this function
 * and reads its rows through it. The page still runs its own query — pulling it
 * through the whole use-case is a bigger change than the one decided — but the
 * RULE has exactly one definition, so "the two surfaces agree" is a property of
 * the code and not a promise a comment makes.
 *
 * EXPORTED FOR THAT REASON AND NO OTHER. It is a pure function of (status, slot,
 * now) so a caller with its own rows can apply it without this module's query;
 * `__tests__/appointment-section-boundary.test.ts` pins the boundary itself.
 */
export function sectionOf(
  status: AppointmentStatusV1,
  slot: { startsAt: Date; endsAt: Date },
  now: Date,
): AppointmentSectionV1 {
  if (status === "attended") return "past";
  if (status === "confirmed") return slot.endsAt > now ? "upcoming" : "past";
  // cancelled_by_owner, cancelled_by_org, no_show.
  return "cancelled";
}

export async function listAppointmentsForUser(args: {
  userId: string;
  now: Date;
}): Promise<AppointmentsForUser> {
  const rows = await db
    .select({
      appointmentToken: appointments.publicToken,
      status: appointments.status,
      organizationId: appointments.organizationId,
      startsAt: timeSlots.startsAt,
      endsAt: timeSlots.endsAt,
      offeringName: serviceOfferings.displayName,
      serviceKind: serviceOfferings.serviceKind,
      durationMinutes: serviceOfferings.durationMinutes,
      priceArs: serviceOfferings.priceArs,
      petPublicToken: pets.publicToken,
      petName: pets.name,
      orgDisplayName: organizations.displayName,
      orgPhone: organizations.phone,
      // THE OFFERING'S OWN locality, never the organisation's registered
      // address — see `resolveProvider` below for why. `serviceOfferings` is
      // already INNER joined here.
      offeringLocality: serviceOfferings.jurisdictionLocality,
      providerDisplayName: profiles.displayName,
      providerMatricula: profiles.matriculaNumber,
      providerPhone: profiles.phone,
    })
    .from(appointments)
    .innerJoin(timeSlots, eq(timeSlots.id, appointments.slotId))
    .innerJoin(serviceOfferings, eq(serviceOfferings.id, appointments.serviceOfferingId))
    // Art. 16 (Ley 25.326) — see the header. An erased animal reads as never
    // registered, including to the foster whose appointment outlived it.
    .innerJoin(pets, and(eq(pets.id, appointments.petId), isNull(pets.deletedAt)))
    .leftJoin(organizations, eq(organizations.id, appointments.organizationId))
    .leftJoin(profiles, eq(profiles.id, serviceOfferings.providerUserId))
    .where(eq(appointments.ownerUserId, args.userId));

  const items: AppointmentListItem[] = [];

  for (const row of rows) {
    if (!isKnownAppointmentStatus(row.status)) continue;
    const status = row.status;

    items.push({
      appointmentToken: row.appointmentToken,
      status,
      section: sectionOf(status, { startsAt: row.startsAt, endsAt: row.endsAt }, args.now),
      pet: { publicToken: row.petPublicToken, name: row.petName },
      offeringName: row.offeringName,
      serviceKind: row.serviceKind,
      serviceKindLabel: findServiceKind(row.serviceKind)?.label ?? null,
      provider: resolveProvider(row),
      durationMinutes: row.durationMinutes,
      priceArs: priceToNumber(row.priceArs),
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      // THE TWO WINDOWS DIFFER, and the difference is the feature's rather than
      // a rounding choice: cancelling closes when the turno starts (the writer
      // refuses "un turno que ya pasó"), and the check-in QR stays good until it
      // ENDS, because somebody arriving late still has to be let in.
      canCancel: status === "confirmed" && row.startsAt > args.now,
      canCheckIn: status === "confirmed" && row.endsAt > args.now,
    });
  }

  return {
    // SOONEST FIRST for what is ahead — the next thing a person has to attend is
    // the answer to the question they opened the screen with. The web orders
    // everything `starts_at DESC`, which puts the FURTHEST-AWAY turno at the top
    // of "Próximos"; that reads as the next one and is not.
    upcoming: items
      .filter((i) => i.section === "upcoming")
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()),
    // Newest first for both histories, which is the web's order and the right one:
    // what happened most recently is what somebody is looking for.
    past: items
      .filter((i) => i.section === "past")
      .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime()),
    cancelled: items
      .filter((i) => i.section === "cancelled")
      .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime()),
  };
}

/**
 * The provider, from the XOR pair.
 *
 * `organizationId` ON THE APPOINTMENT is the discriminator, not the offering's —
 * the column is denormalised onto the booking at insert time (`book-slot.ts`),
 * so it is what the row itself says about who it was booked with. The names come
 * from LEFT joins, so either side can be absent for a deleted org or profile;
 * that is `unknown`, and the client owns the sentence for it.
 *
 * `locality` IS THE OFFERING'S, NOT THE ORGANISATION'S — fixed 2026-09-04. This
 * query used to select `organizations.jurisdiction_locality` here, so a turno
 * booked with an org that runs offerings away from its own registered address
 * (e.g. the La Matanza and Palermo pilot offerings run by one Recoleta-based
 * clinic) showed that home address on every turno, regardless of which
 * offering was actually booked. Same bug, same fix as `coverageLabel` in
 * `appointment-search.ts` (2026-08-13): the offering's own jurisdiction
 * columns are what the booking is valid against, and `serviceOfferings` is
 * already joined in this query.
 */
function resolveProvider(row: {
  organizationId: string | null;
  orgDisplayName: string | null;
  orgPhone: string | null;
  offeringLocality: string | null;
  providerDisplayName: string | null;
  providerMatricula: string | null;
  providerPhone: string | null;
}): AppointmentProvider {
  if (row.organizationId !== null && row.orgDisplayName !== null) {
    return {
      kind: "organization",
      displayName: row.orgDisplayName,
      phone: row.orgPhone,
      locality: row.offeringLocality,
    };
  }
  if (row.organizationId === null && row.providerDisplayName !== null) {
    return {
      kind: "professional",
      displayName: row.providerDisplayName,
      matriculaNumber: row.providerMatricula,
      phone: row.providerPhone,
    };
  }
  return { kind: "unknown" };
}
