// Libreta sanitaria view — Libreta Nacional redesign (handoff §4).
//
// Section 01 Registro de vacunación → LnVaccineLedger (ruled table).
// Section 02 Historial clínico → LnTimeline (dot+icon by type, vertical connector).
// Footer: "Asientos firmados digitalmente · inmutables" + export.
//
// Render logic (groupedEvents, agrupada/cronologica toggle) is UNCHANGED.

import { Icon } from "@/components/Icon";
import { ConfidenceBadge } from "@/components/event/ConfidenceBadge";
import { applierAttribution } from "@/components/pet-profile/asiento-fields";
import { LnButton } from "@/components/ui/Button";
import { LnSectionHead } from "@/components/ui/DocElements";
import { LnEmptyState } from "@/components/ui/EmptyState";
import { LnVaccineLedger, type LnVaccineRow } from "@/components/ui/Ledger";
import type { LnVstampVariant } from "@/components/ui/StatusFlag";
import type { EventType } from "@/db/schema";
import { eventPayloadSummary } from "@/lib/events/events";
import {
  LIBRETA_GROUPS,
  LIBRETA_GROUP_LABELS,
  type LibretaGroupKey,
  libretaConfidenceTier,
} from "@/lib/infra/libreta-sanitaria";
import { notificableEno, tipoEventoLabel, tipoEventoNorma } from "@/lib/reference/sanitary-vocab";
import { AR_TIME_ZONE, eventTypeLabel, formatDate, parseDateInput } from "@/lib/utils/format";

// A date-only "YYYY-MM-DD" next_due_at (legacy rows written before the
// noon-UTC normalization) is midnight UTC = 21:00 of the PREVIOUS AR day, so
// the "vencida" status flipped 3 hours early and the printed date was one day
// off. Anchor date-only values at noon UTC (parseDateInput); full ISO
// timestamps pass through. Same guard as pet-compliance.ts::parseNextDue.
function parseNextDue(raw: string): Date | null {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? parseDateInput(raw) : new Date(raw);
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

type Event = {
  id: string;
  eventType: string;
  payload: unknown;
  occurredAt: Date | string;
  notes: string | null;
  authorRole: string;
  authorVerified: boolean;
  authorOrganizationId: string | null;
  tipoEventoCode?: string | null;
};

type Props = {
  groupedEvents: Record<LibretaGroupKey, Event[]>;
  publicToken: string;
  vista: "agrupada" | "cronologica";
};

export function LibretaSanitariaView({ groupedEvents, publicToken, vista }: Props) {
  if (vista === "cronologica") {
    return <ChronologicalView groupedEvents={groupedEvents} publicToken={publicToken} />;
  }

  const nonEmpty = LIBRETA_GROUPS.filter((g) => groupedEvents[g].length > 0);
  if (nonEmpty.length === 0) return <EmptyLibreta />;

  // Separate vaccination group from the rest for the LnVaccineLedger treatment
  const vaccinationEvents = groupedEvents.vacunas ?? [];
  const otherGroups = nonEmpty.filter((g) => g !== "vacunas");

  return (
    <div className="space-y-[32px]">
      {/* Section 01 — Vaccination ledger */}
      {vaccinationEvents.length > 0 && (
        <section>
          <LnSectionHead
            num="01"
            title="Registro de vacunación"
            meta="Asientos de la libreta"
            className="mb-4"
          />
          <LnVaccineLedger rows={vaccinationEvents.map(eventToVaccineRow)} />
        </section>
      )}

      {/* Section 02+ — Clinical history as timeline */}
      {otherGroups.map((group, idx) => (
        <section key={group}>
          <LnSectionHead
            num={String(idx + (vaccinationEvents.length > 0 ? 2 : 1)).padStart(2, "0")}
            title={LIBRETA_GROUP_LABELS[group]}
            meta={`${groupedEvents[group].length} asiento${groupedEvents[group].length !== 1 ? "s" : ""}`}
            className="mb-4"
          />
          <LnTimelineSection events={groupedEvents[group]} publicToken={publicToken} />
        </section>
      ))}

      <PaperLibretaRoadmapCta />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vaccination row adapter
// ---------------------------------------------------------------------------

function eventToVaccineRow(event: Event): LnVaccineRow {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const occurredDate =
    event.occurredAt instanceof Date ? event.occurredAt : new Date(event.occurredAt);
  const appliedAt = occurredDate.toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: AR_TIME_ZONE,
  });

  const nextDueRaw = p.next_due_at ?? p.next_due ?? null;
  const nextDueDate =
    typeof nextDueRaw === "string" && nextDueRaw ? parseNextDue(nextDueRaw) : null;
  const nextDue = nextDueDate
    ? nextDueDate.toLocaleDateString("es-AR", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: AR_TIME_ZONE,
      })
    : undefined;

  // Derive vstamp status from next_due_at. A NULL next_due_at means we don't
  // know when the next dose is due — "we don't know" must never be sealed
  // green "VIGENTE" on a medical document (state-honesty audit); only a
  // known-future refuerzo date earns "ok". Default is the neutral "unknown"
  // stamp, distinct from genuinely-current (ok) and expired (over).
  let status: LnVstampVariant = "unknown";
  if (nextDueDate) {
    const now = new Date();
    const daysUntil = (nextDueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    if (daysUntil < 0) status = "over";
    else if (daysUntil < 30) status = "due";
    else status = "ok";
  }

  // Free-text applier first; for a SIGNED event with the field blank, fall
  // back to the signature via the SAME attributor the asiento card uses
  // (applierAttribution) — a second local fallback here briefly printed
  // different strings for the same event on two surfaces. Events are
  // append-only, so doses signed before atender started defaulting this field
  // (2026-08-18) can never be backfilled — without the fallback the shared
  // libreta showed PROFESIONAL "—" on a vet-signed dose while an
  // owner-declared one displayed its cited name: the row with MORE provenance
  // looked like it had less.
  const payloadApplier =
    typeof p.administered_by === "string" && p.administered_by.trim()
      ? p.administered_by
      : typeof p.vet_name === "string" && p.vet_name.trim()
        ? p.vet_name
        : null;
  const attribution = applierAttribution(
    {
      authorRole: event.authorRole,
      authorVerified: event.authorVerified,
      authorOrganizationId: event.authorOrganizationId,
    },
    payloadApplier,
  );
  // "Declarado por el titular" is the attributor's owner-declared branch; on
  // this ledger the column is specifically the PROFESSIONAL, so that branch
  // stays an em dash (the owner is already named as the record's author).
  const vetName = attribution.missing ? "—" : attribution.value;

  const vetLicense = typeof p.vet_license === "string" ? p.vet_license : undefined;

  return {
    id: event.id,
    name:
      typeof p.vaccine_name === "string"
        ? p.vaccine_name
        : (tipoEventoLabel(event.tipoEventoCode) ?? "Vacuna"),
    dose: typeof p.dose === "string" ? p.dose : undefined,
    appliedAt,
    nextDue,
    status,
    vet: vetName,
    vetLicense,
  };
}

// ---------------------------------------------------------------------------
// Timeline section for clinical events
// ---------------------------------------------------------------------------

function eventColor(eventType: string): string {
  switch (eventType) {
    case "weight_recorded":
      return "var(--color-ln-celeste)";
    case "vet_visit_logged":
      return "var(--color-ln-ok)";
    case "medication_started":
    case "medication_stopped":
      return "var(--color-ln-violeta)";
    case "note_added":
      return "var(--color-ln-warn)";
    case "sterilization_performed":
      return "var(--color-ln-rosa)";
    case "microchip_implanted":
      return "var(--color-ln-azul)";
    case "death_recorded":
      return "var(--color-ln-mute)";
    default:
      return "var(--color-ln-celeste)";
  }
}

// Returns an ICON_MAP name for the timeline dot; rendered via <Icon>.
function eventIcon(eventType: string): string {
  switch (eventType) {
    case "weight_recorded":
      return "peso";
    case "vet_visit_logged":
      return "vet";
    case "medication_started":
      return "medicacion";
    case "medication_stopped":
      return "medicacion-fin";
    case "note_added":
      return "nota";
    case "sterilization_performed":
      return "esterilizacion";
    case "microchip_implanted":
      return "microchip";
    case "clinical_info_logged":
      return "clinico";
    case "death_recorded":
      return "fallecimiento";
    default:
      return "circle";
  }
}

function LnTimelineSection({
  events,
  publicToken: _publicToken,
}: {
  events: Event[];
  publicToken: string;
}) {
  if (events.length === 0) return null;

  return (
    <div className="flex flex-col gap-0">
      {events.map((event, i) => {
        const summary = eventPayloadSummary(event.eventType, event.payload);
        const senasaLabel = tipoEventoLabel(event.tipoEventoCode);
        const senasaNorma = tipoEventoNorma(event.tipoEventoCode);
        const isEno = notificableEno(event.tipoEventoCode);
        const confidenceTier = libretaConfidenceTier({
          authorRole: event.authorRole,
          authorVerified: event.authorVerified,
          authorOrganizationId: event.authorOrganizationId,
          payload: (event.payload ?? {}) as Record<string, unknown>,
        });

        const date =
          event.occurredAt instanceof Date ? event.occurredAt : new Date(event.occurredAt);
        // AR-pinned parts: getDate()/getFullYear() read the AMBIENT zone
        // (UTC on the server, the viewer's zone in the browser), so a
        // late-evening timestamp rendered a different day server-side than
        // client-side (hydration risk) — and the wrong AR day either way.
        const dayStr = date.toLocaleDateString("es-AR", {
          day: "2-digit",
          timeZone: AR_TIME_ZONE,
        });
        const monthStr = date
          .toLocaleDateString("es-AR", { month: "short", timeZone: AR_TIME_ZONE })
          .toUpperCase()
          .replace(".", "");
        const yearStr = date.toLocaleDateString("es-AR", {
          year: "numeric",
          timeZone: AR_TIME_ZONE,
        });

        const color = eventColor(event.eventType);
        const icon = eventIcon(event.eventType);
        const isLast = i === events.length - 1;

        return (
          <div key={event.id} className="grid" style={{ gridTemplateColumns: "96px 34px 1fr" }}>
            {/* Date */}
            <div
              className="flex flex-col items-end justify-start pr-4 pt-[11px]"
              style={{ fontFamily: "var(--font-ln-mono)" }}
            >
              <span
                className="text-sm font-semibold leading-tight"
                style={{ color: "var(--color-ln-ink-2)" }}
              >
                {dayStr} {monthStr}
              </span>
              <span className="text-xs" style={{ color: "var(--color-ln-mute)" }}>
                {yearStr}
              </span>
            </div>

            {/* Dot + line */}
            <div className="flex flex-col items-center">
              <div
                className="mt-[11px] flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center rounded-full border-2 text-sm"
                style={{
                  borderColor: color,
                  color,
                  background: "var(--color-ln-card)",
                }}
              >
                <Icon name={icon} size={16} decorative />
              </div>
              {!isLast && (
                <div
                  className="w-px flex-1"
                  style={{
                    background: "var(--color-ln-line-2)",
                    minHeight: 18,
                  }}
                />
              )}
            </div>

            {/* Card.
                min-w-0: this is the `1fr` track of a `96px 34px 1fr` grid, and
                a grid item's automatic minimum size is its MIN-CONTENT, not
                zero. 130px of the row is already spoken for by the two fixed
                tracks, so on a 390px phone the card gets ~200px — and any
                unbreakable run longer than that in the free-text fields below
                (event notes, a payload summary, a SENASA norm citation) would
                push the whole row wider than the viewport with nothing in the
                ancestor chain to clip or scroll it. min-w-0 lets the track
                shrink; break-words makes the long run wrap instead. */}
            <div className="ml-3.5 mb-3.5 mt-2 min-w-0 break-words rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-3.5 py-[11px]">
              <div className="flex flex-wrap items-center gap-[7px]">
                <p className="m-0 text-md font-semibold" style={{ color: "var(--color-ln-ink)" }}>
                  {senasaLabel ?? summary.primary ?? eventTypeLabel(event.eventType as EventType)}
                </p>
                <ConfidenceBadge tier={confidenceTier} />
                {isEno && (
                  <span
                    className="rounded-full border border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-025)] px-[7px] py-px font-ln-mono text-xs font-semibold uppercase tracking-[.08em]"
                    style={{ color: "var(--color-ln-warn)" }}
                    title="Notificable ENO (Enfermedades de Notificación Obligatoria, Ley 15.465)"
                  >
                    ENO
                  </span>
                )}
              </div>
              {senasaNorma && (
                <p
                  className="mt-0.5 font-ln-mono text-sm"
                  style={{ color: "var(--color-ln-mute)" }}
                >
                  {senasaNorma}
                </p>
              )}
              {summary.secondary && (
                <p className="mt-0.5 text-sm" style={{ color: "var(--color-ln-ink-2)" }}>
                  {summary.secondary}
                </p>
              )}
              {event.notes && (
                <p className="mt-[3px] text-sm italic" style={{ color: "var(--color-ln-mute)" }}>
                  {event.notes}
                </p>
              )}
              <div
                className="mt-2 flex flex-wrap items-center gap-3 font-ln-mono text-sm"
                style={{ color: "var(--color-ln-mute)" }}
              >
                <time dateTime={date.toISOString()}>{formatDate(event.occurredAt)}</time>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chronological view
// ---------------------------------------------------------------------------

function ChronologicalView({
  groupedEvents,
  publicToken,
}: {
  groupedEvents: Record<LibretaGroupKey, Event[]>;
  publicToken: string;
}) {
  const occurredMs = (e: Event): number =>
    e.occurredAt instanceof Date ? e.occurredAt.getTime() : new Date(e.occurredAt).getTime();
  const all = LIBRETA_GROUPS.flatMap((g) => groupedEvents[g]).sort(
    (a, b) => occurredMs(b) - occurredMs(a),
  );
  if (all.length === 0) return <EmptyLibreta />;

  // Separate vaccine events for ledger, rest for timeline
  const vaccineEvents = all.filter((e) => e.eventType === "vaccination_administered");
  const otherEvents = all.filter((e) => e.eventType !== "vaccination_administered");

  return (
    <div className="space-y-[32px]">
      {vaccineEvents.length > 0 && (
        <section>
          <LnSectionHead num="01" title="Registro de vacunación" className="mb-4" />
          <LnVaccineLedger rows={vaccineEvents.map(eventToVaccineRow)} />
        </section>
      )}
      {otherEvents.length > 0 && (
        <section>
          <LnSectionHead
            num="02"
            title="Historial clínico"
            meta="orden cronológico"
            className="mb-4"
          />
          <LnTimelineSection events={otherEvents} publicToken={publicToken} />
        </section>
      )}

      <PaperLibretaRoadmapCta />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyLibreta() {
  return (
    <LnEmptyState
      variant="dashed"
      title="Todavía no hay registros en esta libreta."
      description="Cuando agregues una vacuna, un peso o una visita al vet, va a aparecer acá."
      action={<PaperLibretaRoadmapCta />}
    />
  );
}

// ---------------------------------------------------------------------------
// Roadmap placeholder — "cargar la libreta de papel" (PO-approved pattern:
// visible, disabled, reads as "coming", never as broken — precedent: the
// "Informe de situación (en desarrollo)" stub in panorama's SituationalMap,
// PO re-ratified visible-in-prod). Placed in the LIBRETA (not the alta/
// registration flow — explicit PO decision) at the exact spot an owner
// looking at a thin history would wish for backfill: the bottom of both
// rendered libreta views (agrupada + cronológica), AND as the empty state's
// action slot for a pet with zero digital entries yet. Disabled semantics
// (aria-disabled, not a dead link) — no href, no onClick.
// ---------------------------------------------------------------------------

function PaperLibretaRoadmapCta() {
  const label = "Cargar la libreta de papel (en desarrollo)";
  return (
    <div
      data-testid="paper-libreta-roadmap-cta"
      className="mt-2 flex flex-col items-start gap-1.5 rounded-[var(--radius-sm)] border border-dashed border-[var(--color-ln-line-strong)] px-3.5 py-3"
    >
      <LnButton type="button" variant="ghost" size="sm" disabled aria-disabled="true" title={label}>
        <Icon name="libreta" size="sm" decorative />
        {label}
      </LnButton>
      <p className="text-xs text-[var(--color-ln-mute)]">
        Vas a poder pasar la historia en papel a la credencial digital.
      </p>
    </div>
  );
}
