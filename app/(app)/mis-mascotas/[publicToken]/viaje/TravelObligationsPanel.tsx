// TravelObligationsPanel — travel obligations checklist for /viaje
// (movilidad Fase 1, R4.1; v14 "Viaje en pasos", design part 2).
//
// Design D5: a NEW thin panel. It deliberately does NOT widen ObligationKey /
// ComplianceObligationsPanel — those are hard-keyed to the 4 domestic cards
// and requirementLevel must not leak onto them (R4.3).
//
// v14: EACH REQUIREMENT IN THREE LINES — what, its level and state, and its
// action — with everything it said before (the rule, who demands it, the
// source and its date, the legal footnote) behind a native "Ver detalle"
// <details>: nothing was removed, only folded. A requirement met only on the
// owner's word carries the declared seal (PO 2026-10-07).

import type { ReactNode } from "react";

import { LnBadge } from "@/components/ui/Badge";
import type { RequirementLevel } from "@/lib/domain/travel-strictness";
import type { TravelObligation } from "@/lib/projections/travel-compliance";
import { isoToArDateDisplay } from "@/lib/utils/date-input-ar";
import { PET_TRAVEL_DECLARED_SEAL } from "@dim/contract/api";

const LEVEL_BADGE: Record<
  RequirementLevel,
  { label: string; variant: "danger" | "warning" | "info" }
> = {
  blocker: { label: "Bloqueante", variant: "danger" },
  warning: { label: "Atención", variant: "warning" },
  info: { label: "Informativo", variant: "info" },
};

export type TravelObligationsPanelProps = {
  obligations: TravelObligation[];
  /**
   * The "Lo tengo" controls for an obligation that lists documents (PO
   * 2026-10-01). Absent — a deceased animal, a test — the documents are listed
   * read-only with their confirmed state.
   */
  renderDocuments?: (obligation: TravelObligation) => ReactNode;
  /** v14: the one action a requirement offers (trip-actions). */
  renderAction?: (obligation: TravelObligation) => ReactNode;
  /** v14: false where the papers have their own module ("Para llevar"). */
  showDocuments?: boolean;
  /** What an empty list says. */
  emptyText?: string;
};

/** The documents of an obligation, read-only: what the owner has ticked. */
function DocumentsReadOnly({ obligation }: { obligation: TravelObligation }) {
  return (
    <ul className="mt-1 space-y-0.5">
      {(obligation.documents ?? []).map((d) => (
        <li key={d.label} className="text-sm">
          {d.label}: {d.confirmed ? "lo tenés, según indicaste" : "sin confirmar"}
        </li>
      ))}
    </ul>
  );
}

/** Everything a requirement says beyond its three lines. */
function ObligationDetail({ obligation }: { obligation: TravelObligation }) {
  return (
    <details className="group">
      <summary className="inline-flex min-h-8 cursor-pointer items-center text-sm text-[var(--color-ln-azul)] underline underline-offset-2">
        <span className="group-open:hidden">Ver detalle</span>
        <span className="hidden group-open:inline">Ocultar detalle</span>
      </summary>
      <div className="mt-1.5 flex flex-col gap-1 rounded-[var(--radius-sm)] bg-[var(--color-ln-paper-2)] px-3 py-2.5 text-sm text-[var(--color-ln-ink-2)]">
        {obligation.detail && <p>{obligation.detail}</p>}
        {/* What a source adds in its own words (Uruguay's praziquantel, why a
            datum is unconfirmed) — once each. */}
        {[...new Set(obligation.sources.map((source) => source.note).filter(Boolean))].map(
          (note) => (
            <p key={note}>{note}</p>
          ),
        )}
        {obligation.contributingJurisdictions.length > 0 && (
          <p>Exigido por: {obligation.contributingJurisdictions.join(" · ")}</p>
        )}
        {obligation.sources.length > 0 && (
          <ul className="space-y-0.5">
            {obligation.sources.map((source) => (
              <li key={`${source.kind}:${source.id}:${source.sourceUrl}`}>
                <a
                  href={source.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--color-ln-azul)] underline"
                >
                  Fuente: {source.issuerLabel}
                </a>
                , revisada el {isoToArDateDisplay(source.lastVerifiedAt)}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-[var(--color-ln-mute)]">{obligation.legalFootnote}</p>
      </div>
    </details>
  );
}

export function TravelObligationsPanel({
  obligations,
  renderDocuments,
  renderAction,
  showDocuments = true,
  emptyText = "Sin requisitos para el contexto de viaje registrado.",
}: TravelObligationsPanelProps) {
  if (obligations.length === 0) {
    return <p className="px-3.5 py-3 text-sm text-[var(--color-ln-mute)]">{emptyText}</p>;
  }

  return (
    <ol className="divide-y divide-[var(--color-ln-line-2)]">
      {obligations.map((obligation) => {
        const badge = LEVEL_BADGE[obligation.requirementLevel];
        const action = renderAction?.(obligation);
        return (
          <li
            key={obligation.id}
            data-obligation={obligation.id}
            className="flex flex-col gap-1 px-3.5 py-3"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold">{obligation.label}</p>
              <LnBadge variant={badge.variant}>{badge.label}</LnBadge>
            </div>
            {obligation.evidence === "declared" && (
              <p className="self-start rounded-[var(--radius-xs)] border border-dashed border-[var(--color-ln-warn)] bg-[var(--color-ln-warn-050)] px-1.5 py-0.5 text-xs font-semibold text-[var(--color-ln-warn)]">
                {PET_TRAVEL_DECLARED_SEAL}
              </p>
            )}
            <p className="text-sm text-[var(--color-ln-ink-2)]">{obligation.state}</p>
            {/* A stale or unconfirmed source is never folded away. */}
            {obligation.freshnessNotice && (
              <p className="text-sm text-[var(--color-ln-warn)]">{obligation.freshnessNotice}</p>
            )}
            {showDocuments &&
              obligation.documents &&
              obligation.documents.length > 0 &&
              (renderDocuments ? (
                renderDocuments(obligation)
              ) : (
                <DocumentsReadOnly obligation={obligation} />
              ))}
            <div className="mt-1 flex flex-wrap items-center gap-x-3.5 gap-y-2">
              {action}
              <ObligationDetail obligation={obligation} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
