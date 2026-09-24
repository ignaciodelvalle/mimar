"use client";

// EventLedgerRow — client, expandable ledger row (WS-L beat 2: amendment).
//
// Each row renders the immutable event (stream beat) plus a temporal-replay
// deep-link. When the event has an amendment (hasAmendment), the row becomes
// expandable: clicking the toggle loads the event_amended chain and renders it
// ABOVE the original with the copy "Corregido por enmienda — el original se
// conserva". This is the trust/audit "ajá": corrections are NEW events; the
// original is never edited.
//
// A11y: the toggle button carries aria-expanded + aria-controls and moves focus
// into the revealed panel on open (Wave 2 Item 11). The amendment badge uses an
// icon AND text (not colour alone).

import { useId, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { OpButton } from "@/components/ui/dashboard";
import { AR_TIME_ZONE } from "@/lib/utils/format";
import { type AmendmentChainEntry, fetchEventAmendmentChainAction } from "./actions";
import { AUTHOR_ROLE_LABELS, type LedgerRowView } from "./view";

type Props = {
  row: LedgerRowView;
};

export function EventLedgerRow({ row }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [chain, setChain] = useState<AmendmentChainEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();
  const panelRef = useRef<HTMLTableRowElement | null>(null);

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && chain === null && !loading) {
      setLoading(true);
      setError(null);
      const result = await fetchEventAmendmentChainAction(row.id);
      if (result.ok) {
        setChain(result.chain);
      } else {
        setError(result.error);
      }
      setLoading(false);
    }
    if (next) {
      // Move focus into the revealed panel once it renders.
      requestAnimationFrame(() => panelRef.current?.focus());
    }
  }

  const actorLabel = AUTHOR_ROLE_LABELS[row.authorRole] ?? row.authorRole;
  const jurisdiction =
    row.province || row.locality ? [row.locality, row.province].filter(Boolean).join(", ") : "—";

  return (
    <>
      <tr className="border-b border-ln-op-line align-top last:border-0 hover:bg-ln-op-stripe/50 transition-colors">
        {/* Event type (es-AR label) + amendment toggle */}
        <td className="py-2 pr-4">
          <div className="flex flex-col gap-1">
            <span className="font-medium text-ln-op-ink">{row.eventTypeLabel}</span>
            {row.hasAmendment && (
              <span className="inline-flex items-center gap-[5px] text-sm text-ln-op-warn">
                <Icon name="editar" size={12} decorative />
                Corregido por enmienda
              </span>
            )}
            {row.hasAmendment && (
              <OpButton
                type="button"
                onClick={toggle}
                aria-expanded={expanded}
                aria-controls={panelId}
                variant="ghost"
                size="sm"
                className="mt-0.5 w-fit self-start"
              >
                {expanded ? "Ocultar corrección" : "Ver corrección"}
              </OpButton>
            )}
          </div>
        </td>

        {/* Actor (role + verified + org marker) */}
        <td className="py-2 pr-4 text-ln-op-ink-2">
          <span className="inline-flex items-center gap-1">
            {actorLabel}
            {row.authorVerified && (
              <span
                className="inline-flex items-center text-ln-op-ok"
                title="Verificado"
                aria-label="verificado"
              >
                <Icon name="check" size={13} decorative />
              </span>
            )}
          </span>
          {row.authorOrganizationId && (
            <span className="block text-sm text-ln-op-mute">vía organización</span>
          )}
        </td>

        {/* Jurisdiction */}
        <td className="py-2 pr-4 text-ln-op-ink-2">{jurisdiction}</td>

        {/* Occurred + Recorded (both, to reinforce the model) */}
        <td className="py-2 pr-4 text-sm tabular-nums text-ln-op-ink-2">
          <span className="block">
            <span className="text-ln-op-mute">ocurrió</span> {row.occurredAtLabel}
          </span>
          <span className="block text-sm text-ln-op-mute">se registró {row.recordedAtLabel}</span>
        </td>

        {/* Temporal replay deep-link */}
        <td className="py-2 text-right">
          <a
            href={row.replayHref}
            className="text-sm text-ln-op-azul underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ln-op-azul"
          >
            Ver situación a esta fecha
          </a>
        </td>
      </tr>

      {/* Amendment chain panel (beat 2) */}
      {expanded && (
        <tr id={panelId} ref={panelRef} tabIndex={-1} className="border-b border-ln-op-line">
          <td colSpan={5} className="bg-ln-op-stripe/40 px-4 py-3">
            <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-3">
              <p className="mb-2 text-sm font-semibold text-ln-op-ink">
                Corregido por enmienda — el original se conserva
              </p>
              {loading && <p className="text-sm text-ln-op-mute">Cargando corrección…</p>}
              {error && <p className="text-sm text-ln-op-danger">{error}</p>}
              {chain && chain.length === 0 && (
                <p className="text-sm text-ln-op-mute">Sin enmiendas registradas.</p>
              )}
              {chain && chain.length > 0 && (
                <ol className="space-y-2">
                  {chain.map((a) => (
                    <li
                      key={a.id}
                      className="rounded-[var(--radius-md)] border border-ln-op-line-2 bg-ln-op-stripe/40 p-2 text-sm"
                    >
                      <div className="mb-1 flex flex-wrap items-baseline gap-2">
                        <span className="font-medium text-ln-op-ink">
                          Enmienda · {AUTHOR_ROLE_LABELS[a.actorRole] ?? a.actorRole}
                        </span>
                        <span className="text-sm text-ln-op-mute">
                          {new Date(a.occurredAt).toLocaleString("es-AR", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            hourCycle: "h23",
                            timeZone: AR_TIME_ZONE,
                          })}
                        </span>
                      </div>
                      {a.reason && <p className="mb-1 text-ln-op-ink-2">Motivo: {a.reason}</p>}
                      {a.changes.length > 0 && (
                        <ul className="space-y-0.5">
                          {a.changes.map((c, i) => (
                            <li key={`${a.id}-${c.field}-${i}`} className="text-ln-op-ink-2">
                              <span className="font-ln-mono text-sm text-ln-op-mute">
                                {c.field}
                              </span>
                              : {formatChangeValue(c.old)} → {formatChangeValue(c.new)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function formatChangeValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
