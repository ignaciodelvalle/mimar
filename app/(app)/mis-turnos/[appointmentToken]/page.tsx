// /mis-turnos/[appointmentToken] — Libreta Nacional redesign.
// CancelButton, MisTurnosSheetMounter (client components) unchanged.

import { deepLinkAppUrl } from "@dim/contract/links";
import { and, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { Suspense } from "react";

import { LnCard, LnCardBody, LnCardHead } from "@/components/ui/Card";
import { LnCallout } from "@/components/ui/DocElements";
import { appointments, db, organizations, pets, profiles, serviceOfferings, timeSlots } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { findServiceKind } from "@/lib/reference/service-kinds";
import { formatTime } from "@/lib/utils/format";
import { CancelButton } from "./CancelButton";
import { MisTurnosSheetMounter } from "./MisTurnosSheetMounter";

export default async function AppointmentDetailPage({
  params,
}: {
  params: Promise<{ appointmentToken: string }>;
}) {
  const { user } = await requireUserOrRedirect();
  const { appointmentToken } = await params;

  const [row] = await db
    .select({
      appointment: appointments,
      slot: timeSlots,
      offering: serviceOfferings,
      pet: pets,
      org: {
        displayName: organizations.displayName,
        avatarUrl: organizations.avatarUrl,
        email: organizations.email,
        phone: organizations.phone,
      },
      provider: {
        displayName: profiles.displayName,
        matriculaNumber: profiles.matriculaNumber,
        phone: profiles.phone,
      },
    })
    .from(appointments)
    .innerJoin(timeSlots, eq(timeSlots.id, appointments.slotId))
    .innerJoin(serviceOfferings, eq(serviceOfferings.id, appointments.serviceOfferingId))
    // Art. 16: same as the /mis-turnos list — a foster/caretaker booker holds
    // an appointment (ownerUserId = their id) that survives the owner's
    // erasure, so an erased pet's detail would render one click deeper. Drop it
    // and the page 404s, as an erased pet should.
    .innerJoin(pets, and(eq(pets.id, appointments.petId), isNull(pets.deletedAt)))
    .leftJoin(organizations, eq(organizations.id, appointments.organizationId))
    .leftJoin(profiles, eq(profiles.id, serviceOfferings.providerUserId))
    .where(eq(appointments.publicToken, appointmentToken))
    .limit(1);

  if (!row) notFound();
  if (row.appointment.ownerUserId !== user.id) notFound();

  const { appointment, slot, offering, pet, org, provider } = row;
  const kindDef = findServiceKind(offering.serviceKind);

  const providerLabel =
    appointment.organizationId && org
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

  const statusConfig = STATUS_CONFIG[appointment.status] ?? UNKNOWN_STATUS_CONFIG;
  const canCancel = appointment.status === "confirmed" && slot.startsAt > new Date();

  // QR only while the slot is current — a past confirmed appointment (never
  // marked attended/no-show) must not keep offering check-in.
  const showCheckInQr = appointment.status === "confirmed" && slot.endsAt > new Date();
  // The payload comes from the deep-link table, not from a template literal
  // here. It is BYTE-FOR-BYTE what this file used to build — keeping the custom
  // scheme working is deliberate scope, because the https form of this
  // destination would claim a verified App Link and there is no Play-signed
  // fingerprint behind it yet (apps/mobile/app.config.ts). What changes is that
  // the drift is now visible: `DEEP_LINK_MAP.appointment` records that the
  // scheme form (`appointment/…`) and the web form (`/mis-turnos/…`) disagree,
  // which until now was a fact living in two files that never met.
  const qrSvg = showCheckInQr
    ? await QRCode.toString(deepLinkAppUrl("appointment", { appointmentToken }), {
        type: "svg",
        margin: 1,
        width: 180,
        errorCorrectionLevel: "M",
      })
    : null;

  return (
    <div className="mx-auto max-w-md px-8 py-7 pb-12">
      {/* Back */}
      <Link
        href="/mis-turnos"
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← Mis turnos
      </Link>

      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-3">
        <h1 className="m-0 font-ln-serif text-2xl font-semibold leading-tight tracking-[-0.01em] text-[var(--color-ln-ink)]">
          {offering.displayName}
        </h1>
        <span
          className={`flex-shrink-0 inline-flex items-center rounded-[var(--radius-xs)] border px-2 py-0.5 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] ${statusConfig.bg} ${statusConfig.text} ${statusConfig.border}`}
        >
          {statusConfig.label}
        </span>
      </div>

      {/* Cancelled-by-owner confirmation (QA fix 5). The cancel sheet closes
          via full reload — sanctioned confirmation mechanism #1 in
          lib/ui/action-feedback.ts, which BANS stacking a toast on top — so
          the reloaded page itself must state the outcome prominently. The
          small header badge alone was easy to miss; this callout is the first
          block after the header, where a fresh reload lands the viewport.
          It describes the STATE (also on later visits), not the click. */}
      {appointment.status === "cancelled_by_owner" && (
        <div className="mb-5">
          <LnCallout title="Turno cancelado">
            Cancelaste este turno y el horario quedó liberado. Si lo necesitás de nuevo,{" "}
            <Link
              href="/turnos/buscar"
              className="text-[var(--color-ln-azul)] underline underline-offset-2"
            >
              buscá un turno nuevo
            </Link>
            .
          </LnCallout>
        </div>
      )}

      {/* Details */}
      <LnCard className="mb-5">
        <LnCardHead title="Detalle del turno" />
        <LnCardBody>
          <dl className="flex flex-col gap-3">
            <DetailRow label="Mascota">
              <Link
                href={`/mis-mascotas/${pet.publicToken}`}
                className="text-[var(--color-ln-azul)] no-underline hover:underline"
              >
                {pet.name}
              </Link>
            </DetailRow>
            <DetailRow label="Tipo de servicio">{kindDef?.label ?? offering.serviceKind}</DetailRow>
            <DetailRow label="Prestador">{providerLabel}</DetailRow>
            <DetailRow label="Fecha y hora">
              {/* inline-block porque ::first-letter no aplica a inline. */}
              <span className="inline-block first-letter:uppercase">{slotDate}</span> a las{" "}
              {slotTime}
            </DetailRow>
            <DetailRow label="Duración">{offering.durationMinutes} minutos</DetailRow>
            <DetailRow label="Precio">
              {offering.priceArs !== null
                ? `$${Number(offering.priceArs).toLocaleString("es-AR")}`
                : "Gratuito"}
            </DetailRow>
            {/* THE OFFERING'S OWN locality, never the organisation's
                registered address — this used to read
                `org.jurisdictionLocality`. Same bug, same fix as
                `list-appointments-for-user.ts` (2026-09-04) and
                `coverageLabel` in `appointment-search.ts` (2026-08-13).
                Gated on `organizationId`, matching `providerLabel` above: an
                independent professional's offering carries no locality row
                on any appointments surface. */}
            {appointment.organizationId && offering.jurisdictionLocality && (
              <DetailRow label="Localidad">{offering.jurisdictionLocality}</DetailRow>
            )}
            {org?.phone && <DetailRow label="Teléfono">{org.phone}</DetailRow>}
            {!org && provider?.phone && <DetailRow label="Teléfono">{provider.phone}</DetailRow>}
          </dl>
        </LnCardBody>
      </LnCard>

      {/* QR check-in */}
      {showCheckInQr && qrSvg && (
        <LnCard className="mb-5">
          <LnCardHead title="Check-in en la clínica" label="QR" />
          <LnCardBody className="flex flex-col items-center gap-2.5">
            <p className="self-start text-md text-[var(--color-ln-ink-2)]">
              Mostrá este QR cuando llegues. Si el escáner no lo lee, dictá el código de abajo.
            </p>
            <div
              className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-white p-2"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered SVG from qrcode lib
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
            <p className="select-all text-center font-ln-mono text-lg font-bold tracking-widest text-[var(--color-ln-ink)]">
              {appointmentToken}
            </p>
          </LnCardBody>
        </LnCard>
      )}

      {/* Attended notice */}
      {appointment.status === "attended" && (
        <div className="mb-5">
          <LnCallout tone="azul">
            Asististe a este turno. El registro médico quedó guardado en la libreta de {pet.name}.
          </LnCallout>
        </div>
      )}

      {/* Cancel */}
      {canCancel && (
        <div className="border-t border-[var(--color-ln-line-2)] pt-4">
          <Suspense>
            <CancelButton />
          </Suspense>
        </div>
      )}

      {/* Sheet mounter */}
      <Suspense>
        <MisTurnosSheetMounter appointmentToken={appointmentToken} />
      </Suspense>
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

type StatusConfig = { label: string; bg: string; text: string; border: string };

const STATUS_CONFIG: Record<string, StatusConfig> = {
  confirmed: {
    label: "Confirmado",
    bg: "bg-[var(--color-ln-ok-050)]",
    text: "text-[var(--color-ln-ok)]",
    border: "border-[var(--color-ln-ok-100)]",
  },
  attended: {
    label: "Asistido",
    bg: "bg-[var(--color-ln-celeste-050)]",
    text: "text-[var(--color-ln-azul)]",
    border: "border-[var(--color-ln-celeste-100)]",
  },
  cancelled: {
    label: "Cancelado",
    bg: "bg-[var(--color-ln-stripe)]",
    text: "text-[var(--color-ln-mute)]",
    border: "border-[var(--color-ln-line-strong)]",
  },
  cancelled_by_owner: {
    label: "Cancelado por vos",
    bg: "bg-[var(--color-ln-stripe)]",
    text: "text-[var(--color-ln-mute)]",
    border: "border-[var(--color-ln-line-strong)]",
  },
  // Cancelled BY THE ORG/PROVIDER — was previously absent from this map, so
  // it fell through to the confirmed-green badge (state-honesty audit).
  // Neutral "cancelado" treatment, matches AppointmentCard.tsx's existing
  // cancelled_by_org handling for the same label/tone.
  cancelled_by_org: {
    label: "Cancelado por el prestador",
    bg: "bg-[var(--color-ln-stripe)]",
    text: "text-[var(--color-ln-mute)]",
    border: "border-[var(--color-ln-line-strong)]",
  },
  no_show: {
    label: "No asistió",
    bg: "bg-[var(--color-ln-err-050)]",
    text: "text-[var(--color-ln-err)]",
    border: "border-[var(--color-ln-err-100)]",
  },
};

// Fallback for any status not in the map above — must read as unknown/neutral,
// NEVER as the confirmed-green badge (state-honesty audit: an unrecognized
// status previously silently fell back to "Confirmado").
const UNKNOWN_STATUS_CONFIG: StatusConfig = {
  label: "Estado desconocido",
  bg: "bg-[var(--color-ln-stripe)]",
  text: "text-[var(--color-ln-mute)]",
  border: "border-[var(--color-ln-line-strong)]",
};
