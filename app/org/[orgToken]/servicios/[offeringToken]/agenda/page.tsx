// Org portal — schedule rules CRUD for an approved service offering (Fase 2).
// Shows existing active rules in a table + a form to add a new one.
// Soft-delete (→ status='archived') is done server-side; no client action needed.

import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { createScheduleRuleAction, deleteScheduleRuleAction } from "@/app/actions/schedule-rules";
import { materializeOfferingNowAction } from "@/app/actions/slot-materialization";
import { OpCard, OpCardBody } from "@/components/ui/dashboard";
import { db, serviceOfferings, serviceScheduleRules } from "@/db";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { findServiceKind } from "@/lib/reference/service-kinds";
import { formatDateShort } from "@/lib/utils/format";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";

import { AgendaRuleForm } from "./AgendaRuleForm";
import { DeleteRuleButton } from "./DeleteRuleButton";
import { MaterializeNowButton } from "./MaterializeNowButton";

const WEEKDAY_LABELS: Record<number, string> = {
  1: "Lun",
  2: "Mar",
  3: "Mié",
  4: "Jue",
  5: "Vie",
  6: "Sáb",
  7: "Dom",
};

function formatDays(days: number[]): string {
  return days
    .slice()
    .sort((a, b) => a - b)
    .map((d) => WEEKDAY_LABELS[d] ?? d)
    .join(", ");
}

// effectiveFrom/effectiveUntil are `date()` columns — they arrive as bare
// "YYYY-MM-DD" strings. The canonical formatter anchors those at noon UTC;
// parsing them with `new Date(...)` here (UTC midnight) rendered the rule
// "desde 6/8" as "5 ago" (Cowork QA v3, M2a).
function formatDate(d: string | Date | null): string {
  return formatDateShort(d);
}

export default async function AgendaPage({
  params,
}: {
  params: Promise<{ orgToken: string; offeringToken: string }>;
}) {
  const { orgToken, offeringToken } = await params;
  const { organization, membership } = await requireOrgAccessByToken(orgToken);
  const granted = await getGrantedCapabilities(membership);
  const canManage = granted.has("service_offering.create");

  // Fetch the offering, verify it belongs to this org.
  const [row] = await db
    .select({ offering: serviceOfferings })
    .from(serviceOfferings)
    .where(
      and(
        eq(serviceOfferings.publicToken, offeringToken),
        eq(serviceOfferings.organizationId, organization.id),
      ),
    )
    .limit(1);

  if (!row) notFound();

  const { offering } = row;

  // Agenda is only useful for approved offerings.
  if (offering.status !== "approved") {
    redirect(`/org/${orgToken}/servicios/${offeringToken}`);
  }

  const kind = findServiceKind(offering.serviceKind);

  // Active rules (not archived/paused).
  const rules = await db
    .select()
    .from(serviceScheduleRules)
    .where(
      and(
        eq(serviceScheduleRules.serviceOfferingId, offering.id),
        eq(serviceScheduleRules.status, "active"),
      ),
    )
    .orderBy(serviceScheduleRules.effectiveFrom);

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      {/* Header */}
      <header className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
          {organization.displayName} · {kind?.label ?? offering.serviceKind}
        </p>
        <h1 className="text-title font-semibold text-ln-op-ink">Agenda</h1>
        <p className="text-md text-ln-op-mute">
          Reglas de disponibilidad recurrente para{" "}
          <strong className="text-ln-op-ink-2">{offering.displayName}</strong>.
        </p>
      </header>

      {/* Existing rules */}
      <section className="space-y-4">
        <h2 className="text-md font-semibold text-ln-op-ink">Reglas activas</h2>
        {rules.length === 0 ? (
          <p className="text-md text-ln-op-mute">
            Todavía no hay reglas de agenda. Agregá una abajo para que se materialicen turnos.
          </p>
        ) : (
          <OpCard>
            <OpCardBody className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <caption className="sr-only">
                    Reglas de agenda: días, horario y período de vigencia
                  </caption>
                  <thead className="bg-ln-op-stripe border-b border-ln-op-line">
                    <tr>
                      <th
                        scope="col"
                        className="px-4 py-2 text-left text-sm font-semibold text-ln-op-mute uppercase tracking-[0.08em]"
                      >
                        Días
                      </th>
                      <th
                        scope="col"
                        className="px-4 py-2 text-left text-sm font-semibold text-ln-op-mute uppercase tracking-[0.08em]"
                      >
                        Horario
                      </th>
                      <th
                        scope="col"
                        className="px-4 py-2 text-left text-sm font-semibold text-ln-op-mute uppercase tracking-[0.08em]"
                      >
                        Desde
                      </th>
                      <th
                        scope="col"
                        className="px-4 py-2 text-left text-sm font-semibold text-ln-op-mute uppercase tracking-[0.08em]"
                      >
                        Hasta
                      </th>
                      {canManage && (
                        <th
                          scope="col"
                          className="px-4 py-2 text-right text-sm font-semibold text-ln-op-mute uppercase tracking-[0.08em]"
                        >
                          Acción
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ln-op-line">
                    {rules.map((rule) => (
                      <tr key={rule.id} className="hover:bg-ln-op-stripe transition-colors">
                        <td className="px-4 py-3 text-md text-ln-op-ink">
                          {formatDays(rule.daysOfWeek as number[])}
                        </td>
                        <td className="px-4 py-3 font-ln-mono text-sm text-ln-op-ink-2">
                          {rule.startTimeLocal} – {rule.endTimeLocal}
                        </td>
                        <td className="px-4 py-3 text-md text-ln-op-mute">
                          {formatDate(rule.effectiveFrom)}
                        </td>
                        <td className="px-4 py-3 text-md text-ln-op-mute">
                          {rule.effectiveUntil ? formatDate(rule.effectiveUntil) : "Abierto"}
                        </td>
                        {canManage && (
                          <td className="px-4 py-3 text-right">
                            <DeleteRuleButton
                              ruleId={rule.id}
                              orgToken={orgToken}
                              offeringToken={offeringToken}
                              deleteAction={deleteScheduleRuleAction}
                            />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </OpCardBody>
          </OpCard>
        )}
      </section>

      {/* Add rule form */}
      {canManage && (
        <section className="space-y-4">
          <h2 className="text-md font-semibold text-ln-op-ink">Agregar regla</h2>
          <OpCard>
            <OpCardBody>
              <AgendaRuleForm
                serviceOfferingId={offering.id}
                offeringPublicToken={offeringToken}
                orgToken={orgToken}
                createAction={createScheduleRuleAction}
              />
            </OpCardBody>
          </OpCard>
        </section>
      )}

      {/* Materialization — immediate preview */}
      {canManage && rules.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-md font-semibold text-ln-op-ink">Materializar turnos</h2>
          <p className="text-md text-ln-op-mute">
            Genera los turnos de los próximos 60 días a partir de las reglas activas. El cron lo
            hace automáticamente; este botón es para preview inmediato.
          </p>
          <MaterializeNowButton
            offeringToken={offeringToken}
            materializeAction={materializeOfferingNowAction}
          />
        </section>
      )}

      <footer className="pt-4 border-t border-ln-op-line">
        <Link
          href={`/org/${orgToken}/servicios/${offeringToken}`}
          className="text-sm text-ln-op-azul hover:underline"
        >
          ← Volver al servicio
        </Link>
      </footer>
    </div>
  );
}
