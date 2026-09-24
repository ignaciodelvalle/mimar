// Vaccine reminder surface scoped to a single pet — rendered on the pet detail page.
// Renders nothing when there are no active reminders for this pet.

import Link from "next/link";

import { ReminderCard } from "@/components/ReminderCard";
import { LnCard, LnCardBody, LnCardHead } from "@/components/ui/Card";
import type { ActiveReminderRow } from "@/lib/analytics/owner-dashboard";
import { buildReminderVaccineUrl } from "@/lib/ui/reminder-urls";
import { pluralizeEs } from "@/lib/utils/format";

import { DeleteReminderInlineForm } from "./DeleteReminderInlineForm";

// ---------------------------------------------------------------------------
// Date formatting helpers — Spanish, no date-fns dependency.
// ---------------------------------------------------------------------------

const MONTH_NAMES_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

function formatDueAt(dueAt: Date): string {
  const d = dueAt.getDate();
  const m = MONTH_NAMES_ES[dueAt.getMonth()];
  const y = dueAt.getFullYear();
  return `${d} de ${m} de ${y}`;
}

function buildStatusText(daysUntilDue: number): string {
  if (daysUntilDue > 0) {
    return `Vence en ${daysUntilDue} ${pluralizeEs(daysUntilDue, "día")}`;
  }
  if (daysUntilDue === 0) {
    return "Vence hoy";
  }
  const abs = Math.abs(daysUntilDue);
  return `Vencida hace ${abs} ${pluralizeEs(abs, "día")}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PetReminders({
  reminders,
  petToken,
}: {
  reminders: ActiveReminderRow[];
  petToken: string;
}) {
  if (reminders.length === 0) {
    return (
      <LnCard aria-labelledby="pet-reminders-heading">
        <LnCardHead
          title={<span id="pet-reminders-heading">Recordatorios</span>}
          actions={
            <Link
              href={`/mis-mascotas/${petToken}/vacunas/programar`}
              className="text-sm text-[var(--color-ln-azul)] underline-offset-4 hover:underline"
            >
              + Programar
            </Link>
          }
        />
        <LnCardBody>
          <div className="rounded-xl border border-dashed border-[var(--color-ln-line-strong)] p-5 text-center">
            <p className="text-sm text-[var(--color-ln-mute)]">Sin próximas vacunas.</p>
            <p className="mt-1 text-xs text-[var(--color-ln-mute)]">
              Programá un recordatorio y te avisamos cuando se acerque la fecha.
            </p>
            <Link
              href={`/mis-mascotas/${petToken}/vacunas/programar`}
              className="mt-3 inline-block text-xs font-medium text-[var(--color-ln-azul)] hover:underline"
            >
              Programar vacuna →
            </Link>
          </div>
        </LnCardBody>
      </LnCard>
    );
  }

  return (
    <LnCard aria-labelledby="pet-reminders-heading">
      <LnCardHead
        title={<span id="pet-reminders-heading">Recordatorios</span>}
        actions={
          <div className="flex items-center gap-3 text-sm">
            <Link
              href={`/mis-mascotas/${petToken}/vacunas/programar`}
              className="text-[var(--color-ln-azul)] underline-offset-4 hover:underline"
            >
              + Programar
            </Link>
            <Link
              href={`/mis-mascotas/${petToken}?tab=vacunas`}
              className="text-[var(--color-ln-azul)] underline-offset-4 hover:underline"
            >
              Ver vacunas →
            </Link>
          </div>
        }
      />
      <LnCardBody>
        <ul className="grid gap-3">
          {reminders.map((r) => (
            <li key={r.reminderId}>
              <ReminderCard
                variant={r.variant}
                title={r.title}
                petName={r.petName}
                statusText={buildStatusText(r.daysUntilDue)}
                dueAt={`Vence el ${formatDueAt(r.dueAt)}`}
                actions={
                  <div className="flex items-center gap-2">
                    <Link
                      href={buildReminderVaccineUrl(petToken, r.reminderId)}
                      className="px-3 py-1.5 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] text-white text-xs font-medium hover:bg-[var(--color-ln-azul-700)] transition-colors"
                    >
                      Registrar
                    </Link>
                    {/* Client island: the action returns redirectTo (nav
                        contract N3) and the island navigates. */}
                    <DeleteReminderInlineForm petToken={petToken} reminderId={r.reminderId} />
                  </div>
                }
              />
            </li>
          ))}
        </ul>
      </LnCardBody>
    </LnCard>
  );
}
