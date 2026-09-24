// /mis-turnos — Libreta Nacional redesign.
// AppointmentCard (component) is unchanged.

import { and, desc, eq, isNull } from "drizzle-orm";
import Link from "next/link";

import { AppointmentCard } from "@/components/AppointmentCard";
import { LnButton } from "@/components/ui/Button";
import { LnSectionHead } from "@/components/ui/DocElements";
import { LnEmptyState } from "@/components/ui/EmptyState";
import { appointments, db, organizations, pets, profiles, serviceOfferings, timeSlots } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { pluralizeEs } from "@/lib/utils/format";
import {
  isKnownAppointmentStatus,
  sectionOf,
} from "@/src/modules/events/application/booking/list-appointments-for-user";

export default async function MisTurnosPage() {
  const { user } = await requireUserOrRedirect();

  const rows = await db
    .select({
      appointment: appointments,
      slot: {
        startsAt: timeSlots.startsAt,
        endsAt: timeSlots.endsAt,
        capacity: timeSlots.capacity,
        bookingsCount: timeSlots.bookingsCount,
      },
      offering: {
        displayName: serviceOfferings.displayName,
        serviceKind: serviceOfferings.serviceKind,
        durationMinutes: serviceOfferings.durationMinutes,
        priceArs: serviceOfferings.priceArs,
        organizationId: serviceOfferings.organizationId,
      },
      pet: {
        name: pets.name,
        publicToken: pets.publicToken,
      },
      org: {
        displayName: organizations.displayName,
      },
      provider: {
        displayName: profiles.displayName,
      },
    })
    .from(appointments)
    .innerJoin(timeSlots, eq(timeSlots.id, appointments.slotId))
    .innerJoin(serviceOfferings, eq(serviceOfferings.id, appointments.serviceOfferingId))
    // Art. 16: bookSlotAction accepts ANY active ownership role (not just
    // owner), so a foster/caretaker books with appointments.ownerUserId = their
    // own id. The erasure RPC soft-deletes only the role='owner' pet and leaves
    // that foster ownership + this appointment intact — so the erased pet would
    // surface here to a non-owner booker. Drop it.
    .innerJoin(pets, and(eq(pets.id, appointments.petId), isNull(pets.deletedAt)))
    .leftJoin(organizations, eq(organizations.id, appointments.organizationId))
    .leftJoin(profiles, eq(profiles.id, serviceOfferings.providerUserId))
    .where(eq(appointments.ownerUserId, user.id))
    .orderBy(desc(timeSlots.startsAt));

  const now = new Date();

  // THE SECTION RULE IS IMPORTED, NOT WRITTEN HERE, and that import is the whole
  // point of this block. This page used to bucket on `startsAt`, so a turno
  // HAPPENING RIGHT NOW left "Próximos" the instant it began — while
  // `/mis-turnos/[appointmentToken]` kept offering its check-in QR until
  // `endsAt`. Somebody five minutes late looked for their turno under "Próximos"
  // and found it filed under "Pasados", with the QR they needed one tap inside a
  // row they had stopped looking for. The phone's server-side `sectionOf` had
  // already been written the right way and the two surfaces disagreed in
  // silence, because neither predicate had a test.
  //
  // Migrated on the PO's decision of 2026-08-31 by DELETING this page's copy
  // rather than syncing it: `sectionOf` is now the one definition, and the
  // boundary it draws is pinned by `__tests__/appointment-section-boundary.test.ts`.
  //
  // The cost, derived at that function and accepted here: a turno stays in
  // "Próximos" for its own duration after it started — at most 90 minutes for
  // the longest service in the catalogue — and the card's own copy says it can
  // no longer be cancelled. That is the honest state of a consultation in
  // progress.
  // A row whose status is none of the five the CHECK constraint admits is
  // DROPPED, not defaulted — the policy `isKnownAppointmentStatus` documents,
  // and the same thing this page's old chain of equality filters did by
  // accident. `status` is typed `string` here because the constraint is a
  // database fact the compiler cannot see.
  const classified = rows.flatMap((row) =>
    isKnownAppointmentStatus(row.appointment.status)
      ? [{ row, section: sectionOf(row.appointment.status, row.slot, now) }]
      : [],
  );
  const upcoming = classified.filter((c) => c.section === "upcoming").map((c) => c.row);
  const past = classified.filter((c) => c.section === "past").map((c) => c.row);
  const cancelled = classified.filter((c) => c.section === "cancelled").map((c) => c.row);

  // Derived from the buckets actually rendered below — NOT rows.length — so
  // the header count always matches what's on screen. A cancelled_by_org
  // appointment used to disappear from the list but still count toward the
  // total (state-honesty audit: "3 turnos" header, 2 cards shown).
  const totalShown = upcoming.length + past.length + cancelled.length;

  return (
    <div className="mx-auto max-w-2xl px-8 py-7 pb-12">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
            Mis turnos
          </h1>
          <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
            {totalShown === 0
              ? "No hay turnos reservados."
              : `${totalShown} ${pluralizeEs(totalShown, "turno")} en total.`}
          </p>
        </div>
        <Link href="/turnos/buscar">
          <LnButton variant="primary" size="md">
            Buscar turnos
          </LnButton>
        </Link>
      </div>

      {rows.length === 0 && (
        <LnEmptyState
          variant="dashed"
          title="Reservá tu primer turno buscando un servicio disponible."
        />
      )}

      <div className="flex flex-col gap-8">
        {upcoming.length > 0 && (
          <section>
            <LnSectionHead num="01" title="Próximos" className="mb-3.5" />
            <ul className="flex flex-col gap-2.5">
              {upcoming.map((r) => (
                <AppointmentCard key={r.appointment.id} row={r} />
              ))}
            </ul>
          </section>
        )}

        {past.length > 0 && (
          <section>
            <LnSectionHead num="02" title="Pasados" className="mb-3.5" />
            <ul className="flex flex-col gap-2.5">
              {past.map((r) => (
                <AppointmentCard key={r.appointment.id} row={r} />
              ))}
            </ul>
          </section>
        )}

        {cancelled.length > 0 && (
          <section>
            <LnSectionHead num="03" title="Cancelados" className="mb-3.5" />
            <ul className="flex flex-col gap-2.5">
              {cancelled.map((r) => (
                <AppointmentCard key={r.appointment.id} row={r} />
              ))}
            </ul>
          </section>
        )}
      </div>

      {/* Footer */}
      <div className="mt-10 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-[var(--color-ln-line-2)] pt-3.5 font-ln-mono text-sm uppercase tracking-[.04em] text-[var(--color-ln-faint)]">
        <span>Agenda de turnos</span>
        <Link
          href="/mis-mascotas"
          className="normal-case text-[var(--color-ln-azul)] no-underline hover:underline"
        >
          ← Mis mascotas
        </Link>
      </div>
    </div>
  );
}
