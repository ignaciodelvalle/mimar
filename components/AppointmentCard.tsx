import Link from "next/link";

import { findServiceKind } from "@/lib/reference/service-kinds";
import { formatTime } from "@/lib/utils/format";

// Shared appointment row. Used by /mis-turnos (full list) and /inicio
// (dashboard widget, upcoming top 5). The shape covers both
// organization-hosted appointments (offering.organizationId set) and
// independent vet provider appointments (provider set).

export type AppointmentRow = {
  appointment: { publicToken: string; status: string };
  slot: { startsAt: Date };
  offering: { displayName: string; serviceKind: string; organizationId: string | null };
  pet: { name: string };
  org: { displayName: string } | null;
  provider: { displayName: string } | null;
};

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  confirmed: {
    label: "Confirmado",
    className: "bg-[var(--color-ln-ok-050)] text-ln-ok  ",
  },
  attended: {
    label: "Asistido",
    className: "bg-ln-celeste/10 text-ln-azul  ",
  },
  cancelled: {
    label: "Cancelado",
    className: "bg-ln-stripe text-ln-ink  ",
  },
  cancelled_by_owner: {
    label: "Cancelado por vos",
    className: "bg-ln-stripe text-ln-mute  ",
  },
  cancelled_by_org: {
    label: "Cancelado por el prestador",
    className: "bg-ln-stripe text-ln-mute  ",
  },
  no_show: {
    label: "No asistió",
    className: "bg-[var(--color-ln-err-050)] text-ln-err  ",
  },
};

const UNKNOWN_STATUS_BADGE = {
  label: "Estado desconocido",
  className: "bg-ln-stripe text-ln-mute  ",
};

export function AppointmentCard({ row }: { row: AppointmentRow }) {
  const { appointment, slot, offering, pet, org, provider } = row;
  const kindDef = findServiceKind(offering.serviceKind);

  const dateLabel = slot.startsAt.toLocaleDateString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const timeLabel = formatTime(slot.startsAt);

  const providerLabel =
    offering.organizationId && org
      ? org.displayName
      : provider
        ? `Dr/a. ${provider.displayName.split(" ")[0]}`
        : "Profesional independiente";

  const statusBadge = STATUS_BADGE[appointment.status] ?? UNKNOWN_STATUS_BADGE;

  const isUpcoming = appointment.status === "confirmed" && slot.startsAt >= new Date();

  return (
    <li>
      <Link
        href={`/mis-turnos/${appointment.publicToken}`}
        className="block border border-ln-line  rounded-xl p-4 hover:bg-ln-stripe  transition-colors"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium text-ln-ink  truncate">{offering.displayName}</p>
            <p className="text-xs text-ln-mute ">
              {pet.name} · {providerLabel}
            </p>
            {/* first-letter, no capitalize: "Sabado, 8 De Agosto" era el
                sintoma de subir la inicial de cada palabra. */}
            <p className="text-xs text-ln-mute first-letter:uppercase">
              {dateLabel} · {timeLabel}
            </p>
            {kindDef && <p className="text-xs text-ln-mute ">{kindDef.label}</p>}
            {isUpcoming && (
              <p className="pt-1 text-xs font-medium text-ln-azul ">Ver QR de check-in →</p>
            )}
          </div>
          <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full ${statusBadge.className}`}>
            {statusBadge.label}
          </span>
        </div>
      </Link>
    </li>
  );
}
