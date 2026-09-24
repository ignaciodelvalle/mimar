// SoloVetAgendaLanding — agenda-first landing for a one-person clinic (four-actor
// lean IA critique §3). A solo practitioner lands on today's appointments — the
// issuer's daily loop — instead of the shelter-oriented ops dashboard. Each row
// routes into the existing attend flow (/org/[orgToken]/agenda/turnos/[token] →
// AttendanceFormDispatcher), which already emits vet-authored clinical events.
//
// Operator skin (ln-op-* / Op* kit). Read-only presentational server component;
// the org nav rail (from the layout) still exposes every other section, so
// nothing is removed — the landing is just re-ranked to the agenda.

import Link from "next/link";

import { OrgSetupChecklist } from "@/components/OrgSetupChecklist";
import { OpCard, OpCardBody, OpCardHead } from "@/components/ui/dashboard";
import type { TodayAgendaItem } from "@/lib/analytics/org-dashboard";
import type { SetupStep } from "@/lib/infra/org-setup-checklist";
import { findServiceKind } from "@/lib/reference/service-kinds";
import { formatTime } from "@/lib/utils/format";

// "attended" matches components/AppointmentCard.tsx's STATUS_BADGE — the
// owner-facing /mis-turnos list used to say "Asistido" for the same
// appointment.status while this org-facing landing said "Atendido" (copy
// audit 2026-08-04). "cancelled_by_owner"/"cancelled_by_org" stay collapsed
// to a generic "Cancelado" here deliberately: AppointmentCard's personalized
// "Cancelado por vos" / "Cancelado por el prestador" address the OWNER in
// second person, which reads wrong from the org's own agenda.
const STATUS_LABELS: Record<string, string> = {
  confirmed: "Confirmado",
  attended: "Asistido",
  no_show: "No asistió",
  cancelled_by_owner: "Cancelado",
  cancelled_by_org: "Cancelado",
};

export function SoloVetAgendaLanding({
  orgToken,
  orgName,
  appointments,
  checklistSteps = null,
}: {
  orgToken: string;
  orgName: string;
  appointments: TodayAgendaItem[];
  /**
   * First-run setup steps to show above the agenda while onboarding is
   * incomplete (task #17). Null once every step is done — the checklist then
   * disappears and the solo vet sees only their agenda.
   */
  checklistSteps?: SetupStep[] | null;
}) {
  const todayLabel = new Date().toLocaleDateString("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "America/Argentina/Buenos_Aires",
  });

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-wider text-ln-op-mute">{orgName}</p>
        <h1 className="text-xl font-semibold text-ln-op-ink">Agenda de hoy</h1>
        {/* `first-letter:uppercase`, no `capitalize` — la misma convencion que
            el context-bar de panorama ya tiene testeada. capitalize sube la
            inicial de cada palabra y convierte "sabado, 8 de agosto" en
            "Sabado, 8 De Agosto". */}
        <p className="text-sm first-letter:uppercase text-ln-op-mute">{todayLabel}</p>
      </header>

      {/* First-run checklist (task #17) — guides the solo vet through publishing
          services, declaring coverage and starting verification before the
          agenda has anything in it. Auto-hidden by the parent once complete. */}
      {checklistSteps && checklistSteps.length > 0 && (
        <OrgSetupChecklist steps={checklistSteps} orgToken={orgToken} autoFocusFirst />
      )}

      <OpCard>
        <OpCardHead title={`Turnos de hoy · ${appointments.length}`} />
        <OpCardBody className="p-0">
          {appointments.length === 0 ? (
            <p className="p-4 text-center text-sm text-ln-op-mute">
              No hay turnos para hoy. Cuando alguien reserve, aparece acá.
            </p>
          ) : (
            <ul className="divide-y divide-ln-op-line">
              {appointments.map((appointment) => {
                const kind =
                  findServiceKind(appointment.serviceKind)?.label ?? appointment.serviceKind;
                return (
                  <li key={appointment.appointmentToken}>
                    <Link
                      href={`/org/${orgToken}/agenda/turnos/${appointment.appointmentToken}`}
                      className="flex items-center gap-4 px-4 py-3 no-underline transition-colors hover:bg-ln-op-stripe"
                    >
                      <span className="font-ln-mono text-sm font-semibold tabular-nums text-ln-op-ink">
                        {formatTime(appointment.startsAt)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ln-op-ink">
                          {appointment.petName} · {kind}
                        </span>
                        {appointment.ownerName && (
                          <span className="block truncate text-xs text-ln-op-mute">
                            {appointment.ownerName}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-xs text-ln-op-mute">
                        {STATUS_LABELS[appointment.status] ?? appointment.status}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </OpCardBody>
      </OpCard>

      <Link
        href={`/org/${orgToken}/agenda`}
        className="inline-flex items-center gap-1 text-sm font-medium text-ln-op-azul hover:underline"
      >
        Ver agenda completa →
      </Link>
    </div>
  );
}
