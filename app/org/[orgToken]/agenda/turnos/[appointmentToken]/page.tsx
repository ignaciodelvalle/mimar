// /org/[orgToken]/agenda/turnos/[appointmentToken] — appointment detail + attendance (Fase 5).
//
// Capability-gated: appointment.manage.
// Renders the per-service-kind attendance form and no-show / cancel controls.

import { and, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  cancelAppointmentByOrgAction,
  markAppointmentAttendedAction,
  markAppointmentNoShowAction,
} from "@/app/actions/attendance";
import { OpCard, OpCardBody, OpCardHead, OpPill } from "@/components/ui/dashboard";
import { appointments, db, pets, profiles, serviceOfferings, timeSlots } from "@/db";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { findServiceKind } from "@/lib/reference/service-kinds";
import { formatDateShort, formatTime } from "@/lib/utils/format";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";
import { AttendanceFormDispatcher } from "./AttendanceFormDispatcher";

type StatusTone = "ok" | "triaged" | "neutral" | "danger";
const STATUS_PILL: Record<string, { label: string; tone: StatusTone }> = {
  confirmed: { label: "Confirmado", tone: "triaged" },
  attended: { label: "Asistido", tone: "ok" },
  cancelled_by_org: { label: "Cancelado org", tone: "neutral" },
  cancelled_by_owner: { label: "Cancelado dueño", tone: "neutral" },
  no_show: { label: "Ausente", tone: "danger" },
};

export default async function OrgAppointmentDetailPage({
  params,
}: {
  params: Promise<{ orgToken: string; appointmentToken: string }>;
}) {
  const { orgToken, appointmentToken } = await params;

  const { organization, membership } = await requireOrgAccessByToken(orgToken);
  const granted = await getGrantedCapabilities(membership);
  if (!granted.has("appointment.manage")) notFound();

  const [row] = await db
    .select({
      appointment: appointments,
      slot: timeSlots,
      offering: serviceOfferings,
      pet: pets,
      ownerProfile: {
        displayName: profiles.displayName,
        phone: profiles.phone,
      },
    })
    .from(appointments)
    .innerJoin(timeSlots, eq(timeSlots.id, appointments.slotId))
    .innerJoin(serviceOfferings, eq(serviceOfferings.id, appointments.serviceOfferingId))
    // Art. 16: an erased pet's appointment 404s like the agenda row it came
    // from — the detail renders the pet's name, species and owner contact.
    .innerJoin(pets, and(eq(pets.id, appointments.petId), isNull(pets.deletedAt)))
    .leftJoin(profiles, eq(profiles.id, appointments.ownerUserId))
    .where(eq(appointments.publicToken, appointmentToken))
    .limit(1);

  if (!row) notFound();

  // Security: appointment must belong to this org.
  if (row.appointment.organizationId !== organization.id) notFound();

  const { appointment, slot, offering, pet, ownerProfile } = row;
  const kindDef = findServiceKind(offering.serviceKind);

  const slotDate = slot.startsAt.toLocaleDateString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const slotTime = formatTime(slot.startsAt);

  const isActionable = appointment.status === "confirmed";
  const backUrl = `/org/${orgToken}/agenda`;
  const pill = STATUS_PILL[appointment.status] ?? STATUS_PILL.confirmed;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <Link href={backUrl} className="inline-block text-sm text-ln-op-azul hover:underline">
        ← Volver a la agenda
      </Link>

      <header className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
          {organization.displayName}
        </p>
        <h1 className="text-title font-semibold text-ln-op-ink">{offering.displayName}</h1>
      </header>

      <OpCard>
        <OpCardHead
          title="Detalle del turno"
          actions={<OpPill tone={pill.tone}>{pill.label}</OpPill>}
        />
        <OpCardBody>
          <dl className="space-y-3">
            <Row label="Mascota">{pet.name}</Row>
            <Row label="Tipo de servicio">{kindDef?.label ?? offering.serviceKind}</Row>
            <Row label="Fecha y hora">
              {/* inline-block porque ::first-letter no aplica a inline. */}
              <span className="inline-block first-letter:uppercase">{slotDate}</span> a las{" "}
              {slotTime}
            </Row>
            <Row label="Propietario">
              {ownerProfile?.displayName?.split(" ")[0] ?? "—"}
              {ownerProfile?.phone && (
                <span className="ml-2 text-ln-op-mute">{ownerProfile.phone}</span>
              )}
            </Row>
          </dl>
        </OpCardBody>
      </OpCard>

      {isActionable ? (
        <AttendanceFormDispatcher
          appointmentToken={appointmentToken}
          serviceKind={offering.serviceKind}
          backUrl={backUrl}
          onAttend={markAppointmentAttendedAction}
          onNoShow={markAppointmentNoShowAction}
          onCancel={cancelAppointmentByOrgAction}
        />
      ) : (
        <OpCard>
          <OpCardBody>
            <p className="text-md text-ln-op-ink-2">
              Este turno ya fue procesado (estado:{" "}
              <strong className="text-ln-op-ink">{pill.label}</strong>).
            </p>
            {appointment.attendedAt && (
              <p className="text-sm text-ln-op-mute mt-1">
                Asistencia registrada el {formatDateShort(appointment.attendedAt)}.
              </p>
            )}
          </OpCardBody>
        </OpCard>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-ln-op-mute uppercase tracking-[0.08em]">{label}</dt>
      <dd className="text-md text-ln-op-ink mt-0.5">{children}</dd>
    </div>
  );
}
