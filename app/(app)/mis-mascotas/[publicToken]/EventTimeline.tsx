"use client";

import { AuthorChip } from "@/components/pet-profile/AuthorChip";
import { type WeightSample, WeightSparkline } from "@/components/pet-profile/WeightSparkline";
import { AmendedBadge } from "@/components/ui/AmendedBadge";
import { LnBadge } from "@/components/ui/Badge";
import type { EventType } from "@/db/schema";
import { eventPayloadDetails, eventPayloadSummary } from "@/lib/events/events";
import { libretaChipCounts, libretaConfidenceTier } from "@/lib/infra/libreta-sanitaria";
import { ownerConfidenceDisplay } from "@/lib/projections/owner-confidence-display";
import { eventTypeLabel, formatDateTime } from "@/lib/utils/format";
import Link from "next/link";
import { useState } from "react";

// Default chip set — used by /historial and any caller that does not pass
// a narrower subset. Libreta-specific surfaces import LIBRETA_FILTER_CHIPS
// from @/lib/libreta-sanitaria instead.
export const DEFAULT_FILTER_CHIPS: ReadonlyArray<{ type: string; label: string }> = [
  { type: "vaccination_administered", label: "Vacunas" },
  { type: "note_added", label: "Notas" },
  { type: "weight_recorded", label: "Peso" },
  { type: "vet_visit_logged", label: "Visitas" },
  { type: "deworming_administered", label: "Antiparasitarios" },
  { type: "sterilization_performed", label: "Esterilización" },
  { type: "microchip_implanted", label: "Microchip" },
  { type: "medication_started", label: "Medicación · inicio" },
  { type: "medication_stopped", label: "Medicación · fin" },
  { type: "medication_dose_taken", label: "Dosis dadas" },
  { type: "death_recorded", label: "Fallecimiento" },
  { type: "clinical_info_logged", label: "Información clínica" },
  { type: "maltreatment_reported", label: "Maltrato" },
  { type: "abandonment_reported", label: "Abandono" },
  { type: "symptom_observed", label: "Síntomas" },
  { type: "movement_recorded", label: "Movilidad" },
];

export type EventTimelineEvent = {
  id: string;
  eventType: string;
  payload: unknown;
  occurredAt: Date | string;
  notes: string | null;
  attachmentUrl: string | null;
  // Provenance fields (WS-3). Optional so legacy callers (e.g. the memorial
  // view) keep compiling; when present, the row shows a confidence badge.
  authorRole?: string;
  authorVerified?: boolean;
  authorOrganizationId?: string | null;
  // Set when a later event_amended corrected this row — shows "Corregido".
  amendedAt?: Date | string | null;
};

type Event = EventTimelineEvent;

// Extracted (C5, 2026-07-21 facades harvest) to keep EventTimelineList's row
// map under the repo's cognitive-complexity budget once the actor chip was
// added — a pure presentational split, no behavior change.
function EventBadgesRow({
  event,
  provenance,
  publicToken,
}: {
  event: EventTimelineEvent;
  provenance: ReturnType<typeof ownerConfidenceDisplay> | null;
  publicToken?: string;
}) {
  if (event.authorRole === undefined && !provenance && !event.amendedAt) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* WHO — role + verified mark, the same citizen-safe chip the per-event
          detail screen already shows (never a personal name; mirrors the
          operator ledger's actor column at the privacy-appropriate level of
          detail). WHEN is the <time> in the row header, already rendered
          unconditionally. */}
      {event.authorRole !== undefined && (
        <AuthorChip role={event.authorRole} verified={event.authorVerified ?? false} />
      )}
      {provenance && <LnBadge variant={provenance.badge}>{provenance.label}</LnBadge>}
      {event.amendedAt && publicToken && (
        <AmendedBadge
          amendedAt={event.amendedAt}
          originalHref={`/mis-mascotas/${publicToken}/eventos/${event.id}`}
        />
      )}
    </div>
  );
}

type Props = {
  events: Event[];
  // Token of the pet that owns these events. Used to build links to the
  // per-event detail screen (/mis-mascotas/{publicToken}/eventos/{eventId}).
  // Optional so legacy callers keep compiling; when absent, rows render as
  // before without the detail link.
  publicToken?: string;
  // Optional narrower subset of filter chips (e.g. LIBRETA_FILTER_CHIPS).
  // When absent, DEFAULT_FILTER_CHIPS is used.
  chips?: ReadonlyArray<{ type: string; label: string }>;
};

// ---------------------------------------------------------------------------
// EventTimelineList — rows only, no chip bar (two-face redesign, 2026-07-01).
// Extracted so LibretaFace (Face 2) can render the "— hoy —" past section
// with the exact row anatomy (H3 curated detail, provenance badge, amendment
// marker) without the per-type chip filter bar — Face 2's lens chips REPLACE
// that filter, they don't sit alongside it.
// ---------------------------------------------------------------------------

export function EventTimelineList({
  events,
  publicToken,
  weightSamples,
}: {
  events: EventTimelineEvent[];
  publicToken?: string;
  /** Full weight history — rendered as an inline sparkline inside each
   * `weight_recorded` row's detail (design ADR-8; no standalone chart). */
  weightSamples?: WeightSample[];
}) {
  if (events.length === 0) {
    return <p className="text-sm text-[var(--color-ln-mute)]">Sin eventos todavía.</p>;
  }

  return (
    <ol className="space-y-3">
      {events.map((event) => {
        const eventType = event.eventType as EventType;
        const summary = eventPayloadSummary(event.eventType, event.payload);
        // H3: curated es-AR detail rows (whitelist) instead of raw JSON.
        const details = eventPayloadDetails(event.eventType, event.payload);
        // Provenance badge (WS-3): collapse the event's confidence tier into
        // one owner-facing badge. Only when author metadata is present.
        const provenance =
          event.authorRole !== undefined
            ? ownerConfidenceDisplay(
                libretaConfidenceTier({
                  authorRole: event.authorRole,
                  authorVerified: event.authorVerified ?? false,
                  authorOrganizationId: event.authorOrganizationId ?? null,
                  payload: (event.payload ?? {}) as Record<string, unknown>,
                }),
              )
            : null;
        // Weight rows show the full trend as an inline sparkline inside "Ver
        // detalle" instead of a standalone chart section (design ADR-8).
        const showWeightSparkline =
          eventType === "weight_recorded" && (weightSamples?.length ?? 0) > 0;
        return (
          <li
            key={event.id}
            className="border border-[var(--color-ln-line)] rounded-[var(--radius-sm)] p-4 space-y-2"
          >
            {publicToken ? (
              <Link
                href={`/mis-mascotas/${publicToken}/eventos/${event.id}`}
                // prefetch=false: this list renders inside FlipCard's Libreta
                // face, which ADR-11 mounts UNCONDITIONALLY (even while the
                // Credencial face is the one showing) so height/ResizeObserver
                // wiring is correct from the first render. Left at the Link
                // default, EVERY row here starts prefetching the instant the
                // page loads — regardless of whether the user ever flips to
                // Libreta — and a timeline can hold many rows. That flood of
                // concurrent background fetches was starving the browser's
                // per-origin connection pool and aborting the real, in-flight
                // navigation fetch for whatever the user actually clicked
                // first (any `?sheet=` action-row icon), producing
                // net::ERR_ABORTED with the URL/dialog never committing —
                // reproduced live and root-caused via Playwright network
                // instrumentation against the :3000 prod build. These are
                // deep archival detail rows; prefetching them eagerly was
                // never load-bearing for UX.
                prefetch={false}
                className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3 -mx-1 px-1 py-0.5 rounded-md hover:bg-[var(--color-ln-stripe)] transition-colors"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="font-medium text-[var(--color-ln-ink)]">
                    {summary.primary ?? eventTypeLabel(eventType)}
                  </p>
                  {summary.secondary && (
                    <p className="text-xs text-[var(--color-ln-mute)]">{summary.secondary}</p>
                  )}
                </div>
                <time className="text-xs text-[var(--color-ln-mute)] sm:shrink-0">
                  {formatDateTime(event.occurredAt)}
                </time>
              </Link>
            ) : (
              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                <div className="min-w-0 space-y-0.5">
                  <p className="font-medium text-[var(--color-ln-ink)]">
                    {summary.primary ?? eventTypeLabel(eventType)}
                  </p>
                  {summary.secondary && (
                    <p className="text-xs text-[var(--color-ln-mute)]">{summary.secondary}</p>
                  )}
                </div>
                <time className="text-xs text-[var(--color-ln-mute)] sm:shrink-0">
                  {formatDateTime(event.occurredAt)}
                </time>
              </div>
            )}
            <EventBadgesRow event={event} provenance={provenance} publicToken={publicToken} />
            {event.notes && <p className="text-sm text-[var(--color-ln-ink-2)]">{event.notes}</p>}
            {event.attachmentUrl && (
              <a
                href={event.attachmentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block"
              >
                <img
                  src={event.attachmentUrl}
                  alt="Foto adjunta"
                  className="max-h-48 w-auto rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] object-cover"
                />
              </a>
            )}
            {(details.length > 0 || showWeightSparkline) && (
              <details className="text-xs text-[var(--color-ln-mute)]">
                <summary className="cursor-pointer select-none hover:text-[var(--color-ln-ink-2)]">
                  Ver detalle
                </summary>
                {details.length > 0 && (
                  <dl className="mt-2 flex flex-col gap-1">
                    {details.map((row) => (
                      <div key={row.label} className="flex gap-2">
                        <dt className="min-w-24 font-medium text-[var(--color-ln-ink-2)]">
                          {row.label}
                        </dt>
                        <dd className="text-[var(--color-ln-ink)]">{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {showWeightSparkline && (
                  <div className="mt-2">
                    <WeightSparkline samples={weightSamples ?? []} height={56} />
                  </div>
                )}
              </details>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function EventTimeline({ events, publicToken, chips }: Props) {
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const effectiveChips = chips ?? DEFAULT_FILTER_CHIPS;

  function toggleType(type: string) {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  // Self-scans are excluded at the DB level (lib/events.excludeSelfScansClause)
  // so no client-side filtering needed here.
  const filteredEvents =
    selectedTypes.size === 0 ? events : events.filter((e) => selectedTypes.has(e.eventType));

  // Per-type counts drive the chip badges and hide chips with no events.
  // Layout follows the mockup: a leading "Todos N" pill + only the chip
  // types that have at least one event in this pet's history. The derivation
  // is shared with the libreta chip bar (libretaChipCounts) so "hide the dead
  // chip, show the count" is one rule, not two copies of one.
  const visibleChips = libretaChipCounts(events, effectiveChips);
  const allSelected = selectedTypes.size === 0;
  const chipClass = (selected: boolean) =>
    selected
      ? "px-3 py-1 rounded-full text-xs font-medium transition-colors bg-[var(--color-ln-azul)] text-white"
      : "px-3 py-1 rounded-full text-xs font-medium transition-colors border border-[var(--color-ln-line)] text-[var(--color-ln-ink-2)] hover:bg-[var(--color-ln-stripe)]";

  if (events.length === 0) {
    return <p className="text-sm text-[var(--color-ln-mute)]">Sin eventos todavía.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setSelectedTypes(new Set())}
          aria-pressed={allSelected}
          className={chipClass(allSelected)}
        >
          Todos {events.length}
        </button>
        {visibleChips.map((chip) => {
          const isSelected = selectedTypes.has(chip.type);
          const count = chip.count;
          return (
            <button
              key={chip.type}
              type="button"
              onClick={() => toggleType(chip.type)}
              aria-pressed={isSelected}
              className={chipClass(isSelected)}
            >
              {chip.label} {count}
            </button>
          );
        })}
      </div>
      {filteredEvents.length === 0 ? (
        <p className="text-sm text-[var(--color-ln-mute)]">Sin eventos de este tipo.</p>
      ) : (
        <EventTimelineList events={filteredEvents} publicToken={publicToken} />
      )}
    </div>
  );
}
