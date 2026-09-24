// Admin Outbox detail page — shows a single outbox row with full payload,
// delivery history, and a manual retry button.
//
// IMPORTANT — the "Reintentar ahora" button does NOT deliver synchronously.
// It resets next_retry_at = now() and status = pending so the drainer cron
// picks the row up on its NEXT run, which is once a day at 04:00
// (`0 4 * * *` — vercel.json and lib/cron/cron-registry.ts; the dispatcher
// explains that the Hobby plan cannot schedule sub-daily). This docblock said
// "within 5 minutes" until 2026-08-04, as did the UI: five minutes is
// BACKOFF_MINUTES[0], the first backoff step, not the drain cadence.

import { requireUuidParam } from "@/lib/infra/route-params";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  OpBreach,
  OpCallout,
  OpCard,
  OpCardBody,
  OpCardHead,
  OpCodeBadge,
  OpCrumbs,
  OpPill,
} from "@/components/ui/dashboard";
import { db, eventNotificationOutbox, petEvents, pets } from "@/db";
import type { EventType } from "@/db/schema";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import {
  buildBreachCue,
  buildStatusLabel,
  externalDeliveryNote,
  isPendingExternalTransmission,
} from "@/lib/infra/outbox-list";
import { eventTypeLabel, formatDateTimeNumericAr } from "@/lib/utils/format";

import { RetryOutboxButton } from "./RetryOutboxButton";

const TARGET_KIND_LABEL: Record<string, string> = {
  govt_webhook: "Webhook de gobierno",
  eno_authority: "Autoridad ENO",
  audit_export: "Exportación auditoría",
  internal_dashboard: "Panel interno",
};

type PillTone = "ok" | "neutral" | "danger" | "escalated";
const STATUS_PILL_TONE: Record<string, PillTone> = {
  pending: "neutral",
  delivered: "ok",
  failed: "escalated",
};

function fmt(d: Date | null): string {
  return formatDateTimeNumericAr(d);
}

export default async function AdminOutboxDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminOrRedirect();

  const { id } = await params;
  // Nonexistent record must answer 404, not a 200 error boundary.
  requireUuidParam(id);

  const [row] = await db
    .select()
    .from(eventNotificationOutbox)
    .where(eq(eventNotificationOutbox.id, id))
    .limit(1);

  if (!row) notFound();

  // Load source event with full context — payload + provenance fields so an
  // operator triaging a delivery breach can see the underlying event without
  // a separate SQL trip. Non-blocking if missing (FK cascade may remove the
  // event in test teardown, but production should always have it).
  const [sourceEvent] = await db
    .select({
      id: petEvents.id,
      eventType: petEvents.eventType,
      occurredAt: petEvents.occurredAt,
      recordedAt: petEvents.recordedAt,
      petId: petEvents.petId,
      payload: petEvents.payload,
      authorRole: petEvents.authorRole,
      authorVerified: petEvents.authorVerified,
      authorOrganizationId: petEvents.authorOrganizationId,
      recordedByUserId: petEvents.recordedByUserId,
    })
    .from(petEvents)
    .where(eq(petEvents.id, row.sourceEventId))
    .limit(1);

  // W3: resolve the source event's pet to a human label + public credential link
  // so the "Evento origen" card leads with "Mascota: <nombre>" instead of a bare
  // UUID. The raw ids stay available under the "Detalle técnico" disclosure below.
  const [petRow] = sourceEvent
    ? await db
        .select({ publicToken: pets.publicToken, name: pets.name })
        .from(pets)
        .where(eq(pets.id, sourceEvent.petId))
        .limit(1)
    : [];

  const cue = buildBreachCue(row.status, row.slaDueAt);
  const jurisdiction = [row.targetJurisdictionLocality, row.targetJurisdictionProvince]
    .filter(Boolean)
    .join(", ");

  const canRetry = row.status === "pending" || row.status === "failed";

  // G7 (2026-08-02): a 'delivered' eno_authority row completed OUR pipeline
  // leg only — no external receiving endpoint exists, so "Entregado" (and the
  // green all-clear tone) would be a lie. buildStatusLabel already renders the
  // honest pending-transmission state when given targetKind; this flag drives
  // the tone + the footer line below.
  const pendingExternal = isPendingExternalTransmission(row.status, row.targetKind);

  return (
    <div className="max-w-3xl space-y-6">
      <OpCrumbs
        items={[
          { label: "Bandeja de salida", href: "/admin/outbox" },
          { label: TARGET_KIND_LABEL[row.targetKind] ?? row.targetKind },
        ]}
      />

      {/* SLA breach banner */}
      {cue === "breach" && (
        <OpBreach
          title="Incumplimiento de SLA detectado"
          detail={`Este ítem superó el deadline de entrega. Estado: ${buildStatusLabel(row.status, row.targetKind)}.`}
        />
      )}

      {/* Header */}
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <OpPill tone={pendingExternal ? "neutral" : (STATUS_PILL_TONE[row.status] ?? "neutral")}>
            {buildStatusLabel(row.status, row.targetKind)}
          </OpPill>
        </div>
        <h1 className="text-title font-semibold text-ln-op-ink">
          {TARGET_KIND_LABEL[row.targetKind] ?? row.targetKind}
        </h1>
        <p className="text-sm text-ln-op-ink-2">{jurisdiction || "Sin jurisdicción"}</p>
        <OpCodeBadge tone="neutral">{row.id}</OpCodeBadge>
      </header>

      {/* Delivery state */}
      <OpCard>
        <OpCardHead title="Estado de entrega" />
        <OpCardBody>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
            <dt className="text-sm text-ln-op-mute">Estado</dt>
            <dd className="text-sm text-ln-op-ink">
              {buildStatusLabel(row.status, row.targetKind)}
            </dd>

            <dt className="text-sm text-ln-op-mute">Intentos</dt>
            <dd className="text-sm text-ln-op-ink">{row.attempts}</dd>

            <dt className="text-sm text-ln-op-mute">Último intento</dt>
            <dd className="text-sm text-ln-op-ink">{fmt(row.lastAttemptAt)}</dd>

            <dt className="text-sm text-ln-op-mute">Próximo reintento</dt>
            <dd className="text-sm text-ln-op-ink">{fmt(row.nextRetryAt)}</dd>

            <dt className="text-sm text-ln-op-mute">Entregado</dt>
            <dd className="text-sm text-ln-op-ink">{fmt(row.deliveredAt)}</dd>

            <dt className="text-sm text-ln-op-mute">Creado</dt>
            <dd className="text-sm text-ln-op-ink">{fmt(row.createdAt)}</dd>

            <dt className="text-sm text-ln-op-mute">SLA vence</dt>
            <dd className="text-sm text-ln-op-ink">
              {fmt(row.slaDueAt)}
              {cue === "breach" && (
                <span className="ml-2 text-ln-op-danger font-semibold text-xs">(INCUMPLIDO)</span>
              )}
            </dd>
          </dl>

          {/* ENO honest-delivery note (C2, 2026-07-22): an eno_authority row's
              "Entregado" status means our outbox pipeline processed it, not
              that the external health authority received it — no receiving
              endpoint exists yet. States reality; never "próximamente" (the
              pipeline itself is real and running today). */}
          {externalDeliveryNote(row.targetKind) && (
            <p className="mt-3 text-sm text-ln-op-mute">{externalDeliveryNote(row.targetKind)}</p>
          )}

          {row.lastError && (
            <div className="mt-3 space-y-1">
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute">
                Último error
              </p>
              <pre className="rounded-[var(--radius-md)] bg-ln-op-danger-bg border border-ln-op-danger-bd p-3 text-xs text-ln-op-danger overflow-auto whitespace-pre-wrap break-words">
                {row.lastError}
              </pre>
            </div>
          )}
        </OpCardBody>
      </OpCard>

      {/* Payload snapshot */}
      <OpCard>
        <OpCardHead title="Payload snapshot" />
        <OpCardBody>
          <pre className="rounded-[var(--radius-sm)] bg-ln-op-stripe p-3 text-xs text-ln-op-ink-2 overflow-auto whitespace-pre-wrap break-words">
            {JSON.stringify(row.payloadSnapshot, null, 2)}
          </pre>
        </OpCardBody>
      </OpCard>

      {/* Source event — type, timestamps, author provenance, full payload */}
      <OpCard>
        <OpCardHead title="Evento origen" />
        <OpCardBody>
          {sourceEvent ? (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                {petRow && (
                  <>
                    <dt className="text-sm text-ln-op-mute">Mascota</dt>
                    <dd className="text-sm">
                      <Link
                        href={`/p/${petRow.publicToken}`}
                        className="text-ln-op-azul underline underline-offset-2 hover:opacity-80"
                      >
                        {petRow.name}
                      </Link>
                    </dd>
                  </>
                )}
                <dt className="text-sm text-ln-op-mute">Tipo</dt>
                <dd>
                  <OpCodeBadge tone="blue">
                    {eventTypeLabel(sourceEvent.eventType as EventType)}
                  </OpCodeBadge>
                </dd>
                <dt className="text-sm text-ln-op-mute">Ocurrido</dt>
                <dd className="text-sm text-ln-op-ink">{fmt(sourceEvent.occurredAt)}</dd>
                <dt className="text-sm text-ln-op-mute">Registrado</dt>
                <dd className="text-sm text-ln-op-ink">{fmt(sourceEvent.recordedAt)}</dd>
                <dt className="text-sm text-ln-op-mute">Rol del autor</dt>
                <dd className="text-sm text-ln-op-ink flex items-center gap-1.5">
                  {sourceEvent.authorRole}
                  {sourceEvent.authorVerified && <OpPill tone="ok">verificado</OpPill>}
                </dd>
              </dl>

              {/* W3: raw identifiers are UUID soup for a human triaging a breach.
                  Keep them available (an operator sometimes needs the exact id for
                  a support trace) but collapsed by default so the card leads with
                  the human context above. */}
              <details className="mt-3">
                <summary className="cursor-pointer text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute">
                  Detalle técnico
                </summary>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
                  {sourceEvent.authorOrganizationId && (
                    <>
                      <dt className="text-sm text-ln-op-mute">Organización</dt>
                      <dd className="font-ln-mono text-xs text-ln-op-mute break-all">
                        {sourceEvent.authorOrganizationId}
                      </dd>
                    </>
                  )}
                  {sourceEvent.recordedByUserId && (
                    <>
                      <dt className="text-sm text-ln-op-mute">Usuario</dt>
                      <dd className="font-ln-mono text-xs text-ln-op-mute break-all">
                        {sourceEvent.recordedByUserId}
                      </dd>
                    </>
                  )}
                  <dt className="text-sm text-ln-op-mute">Pet ID</dt>
                  <dd className="font-ln-mono text-xs text-ln-op-mute break-all">
                    {sourceEvent.petId}
                  </dd>
                  <dt className="text-sm text-ln-op-mute">Event ID</dt>
                  <dd className="font-ln-mono text-xs text-ln-op-mute break-all">
                    {sourceEvent.id}
                  </dd>
                </dl>
              </details>

              {/* Event payload — the canonical record of what actually happened */}
              <div className="space-y-1 pt-3">
                <p className="text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute">
                  Payload del evento
                </p>
                <pre className="rounded-[var(--radius-sm)] bg-ln-op-stripe p-3 text-xs text-ln-op-ink-2 overflow-auto whitespace-pre-wrap break-words">
                  {JSON.stringify(sourceEvent.payload, null, 2)}
                </pre>
              </div>
            </>
          ) : (
            <p className="text-sm text-ln-op-mute">
              Evento origen no encontrado (puede haber sido eliminado).
            </p>
          )}
        </OpCardBody>
      </OpCard>

      {/* Manual retry */}
      {canRetry && (
        <OpCallout
          icon={<span>&#9888;</span>}
          title="Reintentar manualmente"
          body={
            <span className="space-y-2 block">
              {/* "máximo 5 minutos" era falso por un factor de ~288 (auditoría
                  de copy 2026-08-04). Los 5 minutos son el PRIMER escalón del
                  backoff (BACKOFF_MINUTES[0] en lib/infra/outbox-drainer.ts),
                  no la cadencia del drenaje: el drenaje corre una vez por día a
                  las 04:00 (`0 4 * * *` en vercel.json y cron-registry.ts, y el
                  despachador explica que el plan Hobby no admite sub-diario).
                  El código lo sabía; la copy no. */}
              <span className="block">
                Este botón no entrega la notificación al instante. La vuelve a poner en cola para
                que el sistema la reintente en la próxima corrida del drenaje, que se ejecuta una
                vez por día a las 04:00.
              </span>
              <RetryOutboxButton rowId={row.id} />
            </span>
          }
        />
      )}

      {/* G7: the success footer is reserved for rows whose delivery is REAL.
          A 'delivered' eno_authority row only completed our internal pipeline
          leg — the honest pending-transmission state is already the row's
          status and note above, so no all-clear line is earned. */}
      {row.status === "delivered" && !pendingExternal && (
        <p className="text-sm text-ln-op-ok font-semibold">
          Esta fila ya fue entregada exitosamente. No se requiere acción.
        </p>
      )}
    </div>
  );
}
