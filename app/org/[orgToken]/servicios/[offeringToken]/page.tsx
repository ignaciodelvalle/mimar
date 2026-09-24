// Org portal — service offering detail. Shows status, submitted data, rejection
// reason when rejected, a metrics row (approved only), and pause/archive controls.
// Schedule rules CRUD (Fase 2) will live at ./agenda — linked here but not yet built.

import { and, count, eq, gt, sql } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { OpCard, OpCardBody, OpCardHead, OpKpiSm, OpPill } from "@/components/ui/dashboard";
import { appointments, db, organizations, serviceOfferings, timeSlots } from "@/db";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { findServiceKind } from "@/lib/reference/service-kinds";
import { AR_TIME_ZONE, pluralizeEs, speciesLabelPlural } from "@/lib/utils/format";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";

import { CapacityEditor } from "./CapacityEditor";
import { OfferingActions } from "./OfferingActions";

type StatusTone = "open" | "ok" | "danger" | "neutral";
const STATUS_CONFIG: Record<string, { label: string; tone: StatusTone }> = {
  pending_approval: { label: "Pendiente de aprobación", tone: "open" },
  approved: { label: "Aprobado", tone: "ok" },
  rejected: { label: "Rechazado", tone: "danger" },
  paused: { label: "Pausado", tone: "neutral" },
  archived: { label: "Archivado", tone: "neutral" },
};

function formatDate(d: Date | string | null): string {
  if (!d) return "—";
  // Pin the AR timezone: without it the server (UTC) formats a late-evening ART
  // timestamp as the following calendar day. Mirrors the AR_TIME_ZONE convention
  // in lib/utils/format.ts.
  return new Date(d).toLocaleDateString("es-AR", {
    dateStyle: "medium",
    timeZone: AR_TIME_ZONE,
  });
}

export default async function OfferingDetailPage({
  params,
}: {
  params: Promise<{ orgToken: string; offeringToken: string }>;
}) {
  const { orgToken, offeringToken } = await params;
  const { organization, membership } = await requireOrgAccessByToken(orgToken);
  const granted = await getGrantedCapabilities(membership);
  const canCreate = granted.has("service_offering.create");

  // Verify the offering belongs to this org.
  const [row] = await db
    .select({ offering: serviceOfferings, org: organizations })
    .from(serviceOfferings)
    // biome-ignore lint/style/noNonNullAssertion: org-scoped offerings always have organizationId.
    .innerJoin(organizations, eq(organizations.id, serviceOfferings.organizationId!))
    .where(
      and(
        eq(serviceOfferings.publicToken, offeringToken),
        eq(serviceOfferings.organizationId, organization.id),
      ),
    )
    .limit(1);

  if (!row) notFound();

  const { offering } = row;
  const kind = findServiceKind(offering.serviceKind);
  const statusConfig = STATUS_CONFIG[offering.status] ?? STATUS_CONFIG.pending_approval;

  // Metrics — only compute for approved/paused offerings (others have no appointments).
  let metrics: {
    total: number;
    attended: number;
    upcoming: number;
    occupancyPct: number | null;
  } | null = null;

  if (offering.status === "approved" || offering.status === "paused") {
    const now = new Date();
    const next7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [totals] = await db
      .select({
        total: count(),
        attended: sql<number>`count(*) filter (where ${appointments.status} = 'attended')`,
      })
      .from(appointments)
      .where(eq(appointments.serviceOfferingId, offering.id));

    const [upcomingRow] = await db
      .select({ upcoming: count() })
      .from(appointments)
      .where(
        and(eq(appointments.serviceOfferingId, offering.id), eq(appointments.status, "confirmed")),
      );

    // Occupancy next 7 days: booked / total capacity across future slots.
    const [occupancyRow] = await db
      .select({
        booked: sql<number>`coalesce(sum(${timeSlots.bookingsCount}), 0)`,
        capacity: sql<number>`coalesce(sum(${timeSlots.capacity}), 0)`,
      })
      .from(timeSlots)
      .where(
        and(
          eq(timeSlots.serviceOfferingId, offering.id),
          gt(timeSlots.startsAt, now),
          // Serialize the Date before interpolating into a raw sql`` template:
          // a bare JS Date param makes the pg driver throw "Received an instance
          // of Date", 500ing every approved/paused offering (digest 3955119939;
          // same class as the /turnos search-page fix e1ed4559).
          sql`${timeSlots.startsAt} <= ${next7d.toISOString()}`,
        ),
      );

    const cap = occupancyRow?.capacity ?? 0;
    const booked = occupancyRow?.booked ?? 0;
    metrics = {
      total: totals?.total ?? 0,
      attended: Number(totals?.attended ?? 0),
      upcoming: upcomingRow?.upcoming ?? 0,
      occupancyPct: cap > 0 ? Math.round((booked / cap) * 100) : null,
    };
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <header className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
          {organization.displayName} · Servicios
        </p>
        <h1 className="text-title font-semibold text-ln-op-ink">{offering.displayName}</h1>
        <p className="text-md text-ln-op-mute">
          {kind?.label ?? offering.serviceKind} · Enviado el {formatDate(offering.submittedAt)}
        </p>
      </header>

      {/* Status banner */}
      <div className="flex items-center gap-3">
        <OpPill tone={statusConfig.tone}>{statusConfig.label}</OpPill>
        {/* Decía "te notificaremos por email y en el panel". El email no existe
            para este flujo: approve-service-offering.ts y
            reject-service-offering.ts solo insertan una fila en la tabla
            notifications — el aviso del panel — sin ningún canal de correo.
            Prometer un mail
            que nadie manda deja a la veterinaria esperando en la bandeja
            equivocada. Y la espera además no decía quién decide ni qué hacer si
            no pasa nada: nombrar al responsable es la mitad de la lección de
            org-setup-checklist.ts; la otra mitad es no dejar la espera huérfana. */}
        {offering.status === "pending_approval" && (
          <span className="text-sm text-ln-op-mute">
            Lo revisa la autoridad sanitaria de tu jurisdicción. Cuando decida, el aviso te llega
            acá mismo y a tus notificaciones. Si pasan varios días sin respuesta, escribile al
            organismo mencionando el código de este servicio.
          </span>
        )}
        {offering.status === "approved" && (
          <span className="text-sm text-ln-op-mute">
            Ya podés{" "}
            <Link
              href={`/org/${orgToken}/servicios/${offeringToken}/agenda`}
              className="text-ln-op-azul hover:underline font-medium"
            >
              configurar la agenda
            </Link>{" "}
            y empezar a recibir reservas.
          </span>
        )}
        {/* El motivo se mostraba SOLO si venía cargado, así que un rechazo sin
            motivo dejaba la pastilla "Rechazado" sola, sin una palabra de por
            qué ni de qué sigue. Un estado terminal mudo es la peor clase de
            callejón: la persona ve que perdió y no sabe si puede volver a
            intentar. Ahora siempre dice qué pasó y cuál es el camino. */}
        {offering.status === "rejected" && (
          <span className="text-sm text-ln-op-danger">
            {offering.rejectionReason
              ? `Motivo: ${offering.rejectionReason}`
              : "La autoridad no dejó un motivo registrado."}{" "}
            Podés cargar el servicio de nuevo con los datos corregidos desde “Mis servicios”.
          </span>
        )}
      </div>

      {/* Details grid */}
      <OpCard>
        <OpCardHead title="Datos del servicio" />
        <OpCardBody className="p-0">
          <dl className="divide-y divide-ln-op-line">
            <Row label="Token público" value={offering.publicToken} mono />
            <Row label="Tipo de servicio" value={kind?.label ?? offering.serviceKind} />
            <Row
              label="Precio"
              value={
                offering.priceArs !== null
                  ? `$${Number(offering.priceArs).toLocaleString("es-AR")}`
                  : "Campaña gratuita"
              }
            />
            <Row
              label="Duración"
              value={`${offering.durationMinutes} ${pluralizeEs(offering.durationMinutes, "minuto")}`}
            />
            {canCreate && offering.status !== "archived" ? (
              <div className="flex items-baseline gap-3 px-4 py-3 flex-wrap">
                <dt className="text-sm text-ln-op-mute shrink-0 w-36">Capacidad por turno</dt>
                <dd className="text-md text-ln-op-ink flex-1">
                  <CapacityEditor
                    orgToken={orgToken}
                    offeringToken={offeringToken}
                    currentCapacity={offering.slotCapacity}
                  />
                </dd>
              </div>
            ) : (
              <Row
                label="Capacidad por turno"
                value={`${offering.slotCapacity} ${pluralizeEs(offering.slotCapacity, "lugar")}`}
              />
            )}
            {offering.description && <Row label="Descripción" value={offering.description} />}
            {offering.eligibilitySpecies && offering.eligibilitySpecies.length > 0 && (
              <Row
                label="Especies"
                value={offering.eligibilitySpecies.map(speciesLabelPlural).join(", ")}
              />
            )}
            {(offering.eligibilityAgeMinMonths !== null ||
              offering.eligibilityAgeMaxMonths !== null) && (
              <Row
                label="Rango de edad"
                value={[
                  offering.eligibilityAgeMinMonths !== null
                    ? `desde ${offering.eligibilityAgeMinMonths} ${pluralizeEs(offering.eligibilityAgeMinMonths, "mes")}`
                    : null,
                  offering.eligibilityAgeMaxMonths !== null
                    ? `hasta ${offering.eligibilityAgeMaxMonths} ${pluralizeEs(offering.eligibilityAgeMaxMonths, "mes")}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
            )}
            {offering.reviewedAt && (
              <Row label="Revisado el" value={formatDate(offering.reviewedAt)} />
            )}
          </dl>
        </OpCardBody>
      </OpCard>

      {/* Metrics row — approved or paused offerings only */}
      {metrics !== null && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <OpKpiSm label="Turnos totales" value={metrics.total} />
          <OpKpiSm label="Asistencias" value={metrics.attended} />
          <OpKpiSm label="Próximos confirmados" value={metrics.upcoming} />
          <OpKpiSm
            label="Ocupación próx. 7 días"
            value={metrics.occupancyPct !== null ? `${metrics.occupancyPct}%` : "—"}
            tone={
              metrics.occupancyPct === null
                ? "neutral"
                : metrics.occupancyPct >= 80
                  ? "ok"
                  : "neutral"
            }
          />
        </div>
      )}

      {/* CTA for approved offerings */}
      {offering.status === "approved" && (
        <div>
          <Link
            href={`/org/${orgToken}/servicios/${offeringToken}/agenda`}
            className="inline-block px-4 py-2 rounded-[var(--radius-md)] bg-ln-op-azul text-white text-md font-medium hover:opacity-90 transition-opacity"
          >
            Configurar agenda →
          </Link>
        </div>
      )}

      {/* Pausar / eliminar solo tienen sentido sobre un servicio que existe en
          la calle. Un RECHAZADO no se puede pausar —nunca estuvo activo— y
          ofrecer esos botones ahí sugería que el estado se podía administrar
          cuando lo único que corresponde es volver a presentarlo. */}
      {offering.status !== "archived" &&
        offering.status !== "pending_approval" &&
        offering.status !== "rejected" && (
          <div className="pt-2">
            <OfferingActions
              orgToken={orgToken}
              offeringToken={offeringToken}
              status={offering.status}
            />
          </div>
        )}

      <footer className="pt-4 border-t border-ln-op-line">
        <Link
          href={`/org/${orgToken}/servicios`}
          className="text-sm text-ln-op-azul hover:underline"
        >
          ← Volver a mis servicios
        </Link>
      </footer>
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3 px-4 py-3 flex-wrap">
      <dt className="text-sm text-ln-op-mute shrink-0 w-36">{label}</dt>
      <dd className={`text-md text-ln-op-ink flex-1 ${mono ? "font-ln-mono" : ""}`}>{value}</dd>
    </div>
  );
}
