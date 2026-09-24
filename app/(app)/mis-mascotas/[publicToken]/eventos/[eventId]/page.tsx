// Event detail screen — Libreta Nacional redesign.
// Presentation only; data fetching and payload rendering logic unchanged.

import { notReportedClause } from "@/lib/infra/content-reports";
import { requireUuidParam } from "@/lib/infra/route-params";
import dynamic from "next/dynamic";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AuthorChip } from "@/components/pet-profile/AuthorChip";
import { AmendedBadge } from "@/components/ui/AmendedBadge";
import { LnCard, LnCardBody, LnCardHead } from "@/components/ui/Card";
import { attachments, db, petEvents } from "@/db";
import type { EventType } from "@/db/schema";
import { readPoint } from "@/lib/domain/location";
import { eventPayloadDetails, eventPayloadSummary } from "@/lib/events/events";
import { amendAuthorshipRefusal, applyAmendments } from "@/lib/infra/amendment";
import { withholdUnreadableDecomisoEvidence } from "@/lib/infra/decomiso-evidence-access";
import { requireOwnedPetByToken } from "@/lib/infra/pets";
import { eventAttachmentSignedUrl } from "@/lib/infra/storage";
import { eventTypeLabel, formatDateTime } from "@/lib/utils/format";
import { readTitularTenures } from "@/src/modules/events/application/amendment/amend-authorship";
import { fetchLatestAmendmentsForEvents } from "@/src/modules/events/application/amendment/fetch-latest-amendments";
import { readAmendmentChain } from "@/src/modules/events/application/read/load-pet-event-detail";
import { and, eq } from "drizzle-orm";
import { AmendEventButton } from "./AmendEventButton";

const LocationMap = dynamic(() => import("@/components/LocationMap"), {
  loading: () => (
    <div className="w-full h-[240px] rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] animate-pulse" />
  ),
});

export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ publicToken: string; eventId: string }>;
}) {
  const { publicToken, eventId } = await params;
  // Nonexistent record must answer 404, not a 200 error boundary.
  requireUuidParam(eventId);
  const session = await requireOwnedPetByToken(publicToken);
  const { pet, accessPath } = session;

  const [event] = await db
    .select()
    .from(petEvents)
    // A SECOND read of the same row — this page does not go through
    // `loadPetEventDetail`, so the clause has to be here too. Found by the
    // coverage fence, not by reading: a reported item is addressable by URL
    // even when every listing has dropped it.
    .where(and(eq(petEvents.id, eventId), eq(petEvents.petId, pet.id), notReportedClause()))
    .limit(1);
  if (!event) notFound();

  const eventType = event.eventType as EventType;

  // D2 — Check for amendments on this event. Fetched BEFORE deriving the
  // summary/detail rows below so both project the CORRECTED payload — the
  // timeline already applies amendments at its read boundary
  // (overlayAmendments in lib/infra/amendment.ts), but this detail page
  // queried `event.payload` directly and never overlaid the correction,
  // so a corrected vaccine name (etc.) showed its pre-correction value here
  // while the timeline correctly showed the amended one (owner post-impl
  // corrections handoff, clickthrough audit 2026-07-04).
  const amendmentsMap = await fetchLatestAmendmentsForEvents(pet.id, [event.id]);
  const latestAmendment = amendmentsMap.get(event.id) ?? null;
  const correctedPayload = latestAmendment
    ? applyAmendments(event.payload as Record<string, unknown>, [
        {
          id: latestAmendment.amendmentId,
          targetEventId: latestAmendment.targetEventId,
          occurredAt: latestAmendment.occurredAt,
          reason: latestAmendment.reason,
          actorRole: latestAmendment.actorRole,
          changes: latestAmendment.changes,
        },
      ])
    : (event.payload as Record<string, unknown>);

  const summary = eventPayloadSummary(event.eventType, correctedPayload);
  const heading = summary.primary ?? eventTypeLabel(eventType);
  // H3 — curated es-AR key/value rows (whitelist), never a raw JSON dump: the
  // same helper EventTimeline's "Ver detalle" already uses. Never emits
  // firma_hash, evidence_hash, *_id, source, or payload_version.
  const details = eventPayloadDetails(event.eventType, correctedPayload);

  // Decomiso evidence keeps its metadata (PO decision D7): only a viewer who
  // reads the decomiso itself is shown it, not everyone with pet access.
  const eventAttachments = await withholdUnreadableDecomisoEvidence(
    await db.select().from(attachments).where(eq(attachments.eventId, event.id)),
    session.user.id,
  );
  const attachmentUrls = await Promise.all(
    eventAttachments.map(async (a) => ({
      id: a.id,
      mimeType: a.mimeType,
      url: await eventAttachmentSignedUrl(a.storagePath),
    })),
  );

  const point = readPoint(event);

  // D3 — Capability gate: only the person path is offered the button (the
  // org path is not, in v1). D3b (PO decision 3B): and only on a record this
  // viewer may correct — their own, never one a professional wrote or
  // corrected. The server action enforces the same rule; this only keeps the
  // button from offering what the write would refuse. The chain is read only
  // when the first gate passes.
  const canAmend =
    accessPath === "owner" &&
    amendAuthorshipRefusal(
      {
        userId: session.user.id,
        standing: "person",
        titularTenures: await readTitularTenures(pet.id, session.user.id),
      },
      [
        {
          authorRole: event.authorRole,
          authorVerified: event.authorVerified,
          recordedByUserId: event.recordedByUserId,
          recordedAt: event.recordedAt,
        },
        ...(await readAmendmentChain(pet.id, event.id)),
      ],
    ) === null;

  return (
    <div className="mx-auto max-w-2xl px-8 py-7 pb-12">
      {/* Back */}
      <Link
        href={`/mis-mascotas/${pet.publicToken}?tab=historial`}
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← Historial de {pet.name}
      </Link>

      {/* Header */}
      <div className="mb-6">
        <p className="font-ln-mono text-xs uppercase tracking-[.3em] text-[var(--color-ln-mute)]">
          {eventTypeLabel(eventType)}
        </p>
        <h1 className="mt-1 font-ln-serif text-2xl font-semibold leading-tight tracking-[-0.01em] text-[var(--color-ln-ink)]">
          {heading}
        </h1>
        {summary.secondary && (
          <p className="mt-1 text-md text-[var(--color-ln-mute)]">{summary.secondary}</p>
        )}
        {/* Author chip + amended badge */}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <AuthorChip role={event.authorRole} verified={event.authorVerified} />
          {latestAmendment && (
            <AmendedBadge
              amendedAt={latestAmendment.occurredAt}
              originalHref={`/mis-mascotas/${pet.publicToken}?tab=historial`}
            />
          )}
        </div>
      </div>

      {/* Append-only banner + amend affordance */}
      <div
        className="mb-4 flex flex-col gap-2.5 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-3.5 py-2.5"
        role="note"
      >
        <p className="font-ln-mono text-sm text-[var(--color-ln-mute)]">
          Este registro no se puede editar ni borrar — la libreta es un historial inmutable. Si hay
          un dato incorrecto, podés registrar una corrección que queda acreditada en el historial.
        </p>
        <AmendEventButton
          eventId={event.id}
          eventType={event.eventType}
          currentPayload={correctedPayload}
          canAmend={canAmend}
          publicToken={publicToken}
        />
      </div>

      <div className="flex flex-col gap-4">
        {/* Timestamps */}
        <LnCard>
          <LnCardHead title="Fechas" />
          <LnCardBody>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Detail label="Ocurrió" value={formatDateTime(event.occurredAt)} />
              <Detail label="Registrado" value={formatDateTime(event.recordedAt)} />
            </div>
          </LnCardBody>
        </LnCard>

        {/* Notes */}
        {event.notes && (
          <LnCard>
            <LnCardHead title="Notas" />
            <LnCardBody>
              <p className="text-md text-[var(--color-ln-ink-2)] whitespace-pre-wrap">
                {event.notes}
              </p>
            </LnCardBody>
          </LnCard>
        )}

        {/* Location */}
        <LnCard>
          <LnCardHead title="Ubicación" />
          <LnCardBody>
            {point ? (
              <LocationMap lat={point.lat} lng={point.lng} />
            ) : (
              <p className="text-md text-[var(--color-ln-mute)] italic">
                Sin ubicación registrada.
              </p>
            )}
          </LnCardBody>
        </LnCard>

        {/* Payload detail — H3: curated es-AR fields only, never a raw JSON
            dump (owner post-impl corrections handoff H3). */}
        <LnCard>
          <LnCardHead title="Detalle" />
          <LnCardBody>
            {details.length === 0 ? (
              <p className="text-md text-[var(--color-ln-mute)] italic">Sin campos adicionales.</p>
            ) : (
              <dl className="divide-y divide-[var(--color-ln-line-2)]">
                {details.map((row) => (
                  <div
                    key={row.label}
                    className="grid grid-cols-1 gap-1 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-3 sm:gap-3"
                  >
                    <dt className="font-ln-mono text-sm text-[var(--color-ln-mute)]">
                      {row.label}
                    </dt>
                    <dd className="text-md text-[var(--color-ln-ink-2)] break-words sm:col-span-2">
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </LnCardBody>
        </LnCard>

        {/* Attachments */}
        {attachmentUrls.length > 0 && (
          <LnCard>
            <LnCardHead title={`Adjuntos (${attachmentUrls.length})`} />
            <LnCardBody>
              <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {attachmentUrls.map((a) =>
                  a.url ? (
                    <li key={a.id}>
                      <a href={a.url} target="_blank" rel="noopener noreferrer" className="block">
                        {a.mimeType.startsWith("image/") ? (
                          <img
                            src={a.url}
                            alt="Adjunto"
                            className="h-[192px] w-full rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] object-cover"
                          />
                        ) : (
                          <span className="flex h-[96px] w-full items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] text-md text-[var(--color-ln-azul)] no-underline hover:underline">
                            Ver adjunto ({a.mimeType})
                          </span>
                        )}
                      </a>
                    </li>
                  ) : (
                    <li
                      key={a.id}
                      className="flex h-[96px] w-full items-center justify-center rounded-[var(--radius-sm)] border border-dashed border-[var(--color-ln-line-strong)] text-sm text-[var(--color-ln-mute)]"
                    >
                      Adjunto no disponible
                    </li>
                  ),
                )}
              </ul>
            </LnCardBody>
          </LnCard>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="font-ln-mono text-xs uppercase tracking-[.08em] text-[var(--color-ln-mute)]">
        {label}
      </dt>
      <dd className="mt-0.5 text-md text-[var(--color-ln-ink-2)]">{value || "—"}</dd>
    </div>
  );
}
