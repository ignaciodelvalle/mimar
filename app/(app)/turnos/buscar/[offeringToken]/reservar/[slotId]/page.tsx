// Confirmar reserva — Libreta Nacional redesign.

import { requireUuidParam } from "@/lib/infra/route-params";
import { eq, sql } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { LnCard, LnCardBody, LnCardHead } from "@/components/ui/Card";
import { LnCallout } from "@/components/ui/DocElements";
import { db, organizations, ownerships, pets, profiles, serviceOfferings, timeSlots } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { findServiceKind } from "@/lib/reference/service-kinds";
import { formatTime } from "@/lib/utils/format";
import { BookingFormClient } from "./BookingFormClient";

export default async function ReservarTurnoPage({
  params,
}: {
  params: Promise<{ offeringToken: string; slotId: string }>;
}) {
  const { user } = await requireUserOrRedirect();
  const { offeringToken, slotId } = await params;
  // Nonexistent record must answer 404, not a 200 error boundary.
  requireUuidParam(slotId);

  const [offeringRow] = await db
    .select({
      offering: serviceOfferings,
      org: {
        displayName: organizations.displayName,
        avatarUrl: organizations.avatarUrl,
      },
      provider: {
        displayName: profiles.displayName,
        matriculaNumber: profiles.matriculaNumber,
      },
    })
    .from(serviceOfferings)
    .leftJoin(organizations, eq(organizations.id, serviceOfferings.organizationId))
    .leftJoin(profiles, eq(profiles.id, serviceOfferings.providerUserId))
    .where(eq(serviceOfferings.publicToken, offeringToken))
    .limit(1);

  if (!offeringRow || offeringRow.offering.status !== "approved") notFound();

  const [slot] = await db.select().from(timeSlots).where(eq(timeSlots.id, slotId)).limit(1);

  if (
    !slot ||
    slot.serviceOfferingId !== offeringRow.offering.id ||
    slot.status === "cancelled" ||
    slot.bookingsCount >= slot.capacity ||
    slot.startsAt <= new Date()
  ) {
    notFound();
  }

  // Deceased pets are excluded — a turno cannot be booked for them (Cowork
  // QA v3, B2). Same filter shape as lib/analytics/owner-dashboard.ts.
  // Art. 16 (Ley 25.326): an erased pet reads as never registered. bookSlotAction
  // accepts ANY active ownership role, and the erasure leaves a foster/co-owner
  // row intact on the now-soft-deleted pet, so without pets.deletedAt IS NULL a
  // non-owner booker would see the erased pet in this picker and book for it.
  const userPets = await db
    .select({ pet: pets })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      sql`${ownerships.ownerUserId} = ${user.id} AND ${ownerships.endedAt} IS NULL AND ${pets.status} <> 'deceased' AND ${pets.deletedAt} IS NULL`,
    )
    .orderBy(pets.name);

  const { offering, org, provider } = offeringRow;
  const kindDef = findServiceKind(offering.serviceKind);

  const providerLabel =
    offering.organizationId && org
      ? org.displayName
      : provider
        ? `Dr/a. ${provider.displayName.split(" ")[0]}${provider.matriculaNumber ? ` · Mat. ${provider.matriculaNumber}` : ""}`
        : "Profesional independiente";

  const slotDate = slot.startsAt.toLocaleDateString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const slotTime = formatTime(slot.startsAt);

  return (
    <div className="mx-auto max-w-md px-8 py-7 pb-12">
      {/* Back */}
      <Link
        href={`/turnos/buscar/${offeringToken}`}
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← Volver a los turnos
      </Link>

      {/* Header */}
      <div className="mb-6">
        <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
          Confirmar reserva
        </h1>
        <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
          Revisá los datos antes de confirmar. La reserva es inmediata.
        </p>
      </div>

      {/* Summary card */}
      <LnCard className="mb-5">
        <LnCardHead title="Resumen del turno" />
        <LnCardBody>
          <dl className="flex flex-col gap-3">
            <DetailRow label="Servicio">
              <span className="font-medium">{offering.displayName}</span>
              <span className="ml-1.5 font-ln-mono text-sm text-[var(--color-ln-mute)]">
                {kindDef?.label ?? offering.serviceKind}
              </span>
            </DetailRow>
            <DetailRow label="Prestador">{providerLabel}</DetailRow>
            <DetailRow label="Fecha y hora">
              {/* inline-block porque ::first-letter no aplica a elementos
                  inline. capitalize daba "Sabado, 8 De Agosto". */}
              <span className="inline-block first-letter:uppercase">{slotDate}</span> a las{" "}
              {slotTime}
            </DetailRow>
            {offering.priceArs !== null && (
              <DetailRow label="Precio">
                ${Number(offering.priceArs).toLocaleString("es-AR")}
              </DetailRow>
            )}
          </dl>
        </LnCardBody>
      </LnCard>

      {/* Booking form */}
      {userPets.length === 0 ? (
        <LnCallout tone="warn" title="Necesitás una mascota registrada">
          <Link
            href="/mis-mascotas/nueva"
            className="text-[var(--color-ln-azul)] no-underline hover:underline"
          >
            Registrar mascota →
          </Link>
        </LnCallout>
      ) : (
        <BookingFormClient slotId={slotId} userPets={userPets.map((r) => r.pet)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-ln-mono text-xs uppercase tracking-[.08em] text-[var(--color-ln-mute)]">
        {label}
      </dt>
      <dd className="mt-0.5 text-md text-[var(--color-ln-ink-2)]">{children}</dd>
    </div>
  );
}
