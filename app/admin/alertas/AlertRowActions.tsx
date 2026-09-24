"use client";

// app/admin/alertas/AlertRowActions.tsx — per-row triage controls (client island).
//
// The inbox page + table are server components; only this control strip is a
// client island. It calls the K1 server actions (app/actions/alert-firings.ts)
// via useTransition and surfaces the next valid step of the state machine:
//
//   disparada            → Reconocer | Descartar
//   reconocida           → (zoonosis) Abrir investigación | (otra) Registrar seguimiento
//                          + Contactar autoridad | Resolver | Descartar
//   en_investigacion     → Contactar autoridad | Resolver
//   autoridad_contactada → Resolver
//   resuelta | descartada → (cerrada, sin acciones)
//
// "Abrir investigación" is shown ONLY for active_zoonosis (the lone disease-
// mapped metric, K-D2); every other metric gets "Registrar seguimiento".
// Resolve / Descartar / Seguimiento open an inline notes prompt before firing.

import { useState, useTransition } from "react";

import {
  acknowledgeFiringAction,
  contactAuthorityFiringAction,
  dismissFiringAction,
  openInvestigationFiringAction,
  registerFollowupFiringAction,
  resolveFiringAction,
} from "@/app/actions/alert-firings";
import { OpButton, OpTextarea } from "@/components/ui/dashboard";
import type { AlertFiringStatus, AlertMetricKey } from "@/db/schema";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

type Props = {
  firingId: string;
  status: AlertFiringStatus;
  metricKey: AlertMetricKey;
  /** True when the firing has both province + locality (needed to route a govt). */
  hasJurisdiction: boolean;
};

type PromptKind = "resolve" | "dismiss" | "followup" | null;

const ZOONOSIS_METRIC: AlertMetricKey = "active_zoonosis";

export function AlertRowActions({ firingId, status, metricKey, hasJurisdiction }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<PromptKind>(null);
  const [noteValue, setNoteValue] = useState("");

  if (status === "resuelta" || status === "descartada") {
    return <span className="text-sm text-ln-op-mute">—</span>;
  }

  function run(fn: () => Promise<{ ok: true } | { error: string }>) {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if ("error" in res) {
        setError(res.error);
      } else {
        setPrompt(null);
        setNoteValue("");
        // Full document reload so the SSR inbox reflects the new status
        // (router.refresh() is banned — see lib/ui/full-page-action-nav.ts).
        // The actions already revalidatePath("/admin/alertas"), but that only
        // marks the cache entry stale: nothing consumes it while this tree
        // stays mounted, so without this call the row keeps showing the old
        // status and the counter never moves. QA ronda 5 (2026-07-16): the
        // operator acknowledged and resolved a firing, saw the row unchanged,
        // and assumed the action had failed — only a manual reload revealed
        // "0 alertas". Mirrors app/gob/cola/[publicToken]/ReviewActions.tsx.
        navigateAfterActionSuccess(window.location.href);
      }
    });
  }

  // Inline notes prompt (resolve / dismiss / followup).
  if (prompt !== null) {
    const labels: Record<Exclude<PromptKind, null>, { title: string; cta: string }> = {
      resolve: { title: "Resolver alerta", cta: "Resolver" },
      dismiss: { title: "Descartar alerta", cta: "Descartar" },
      followup: { title: "Registrar seguimiento", cta: "Guardar nota" },
    };
    const { title, cta } = labels[prompt];
    return (
      <div className="flex max-w-[320px] flex-col gap-2">
        <label className="text-sm font-semibold text-ln-op-mute" htmlFor={`note-${firingId}`}>
          {title}
        </label>
        <OpTextarea
          id={`note-${firingId}`}
          value={noteValue}
          onChange={(e) => setNoteValue(e.target.value)}
          rows={2}
          placeholder={
            prompt === "followup"
              ? "Qué se hizo / a quién se contactó…"
              : "Nota de cierre (opcional)…"
          }
          size="xs"
          block={false}
        />
        {error ? <p className="text-sm text-ln-op-danger">{error}</p> : null}
        <div className="flex items-center gap-2">
          <OpButton
            type="button"
            disabled={pending}
            onClick={() =>
              run(() => {
                if (prompt === "resolve") return resolveFiringAction(firingId, noteValue);
                if (prompt === "dismiss") return dismissFiringAction(firingId, noteValue);
                return registerFollowupFiringAction(firingId, noteValue);
              })
            }
            variant="primary"
            size="sm"
          >
            {cta}
          </OpButton>
          <OpButton
            type="button"
            disabled={pending}
            onClick={() => {
              setPrompt(null);
              setError(null);
              setNoteValue("");
            }}
            variant="ghost"
            size="sm"
          >
            Cancelar
          </OpButton>
        </div>
      </div>
    );
  }

  const canAcknowledge = status === "disparada";
  const canWork = status === "reconocida" || status === "en_investigacion";
  const isZoonosis = metricKey === ZOONOSIS_METRIC;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {canAcknowledge ? (
          <OpButton
            type="button"
            disabled={pending}
            onClick={() => run(() => acknowledgeFiringAction(firingId))}
            variant="primary"
            size="sm"
          >
            Reconocer
          </OpButton>
        ) : null}

        {status === "reconocida" && isZoonosis ? (
          <OpButton
            type="button"
            disabled={pending}
            onClick={() => run(() => openInvestigationFiringAction(firingId))}
            variant="primary"
            size="sm"
          >
            Abrir investigación
          </OpButton>
        ) : null}

        {status === "reconocida" && !isZoonosis ? (
          <OpButton
            type="button"
            disabled={pending}
            onClick={() => {
              setPrompt("followup");
              setError(null);
            }}
            variant="ghost"
            size="sm"
          >
            Registrar seguimiento
          </OpButton>
        ) : null}

        {canWork ? (
          <OpButton
            type="button"
            disabled={pending || !hasJurisdiction}
            title={
              hasJurisdiction ? undefined : "Sin jurisdicción local: no hay autoridad a contactar."
            }
            onClick={() => run(() => contactAuthorityFiringAction(firingId))}
            variant="ghost"
            size="sm"
          >
            Contactar autoridad
          </OpButton>
        ) : null}

        {canWork || status === "autoridad_contactada" ? (
          <OpButton
            type="button"
            disabled={pending}
            onClick={() => {
              setPrompt("resolve");
              setError(null);
            }}
            variant="ok"
            size="sm"
          >
            Resolver
          </OpButton>
        ) : null}

        {canAcknowledge || status === "reconocida" ? (
          <OpButton
            type="button"
            disabled={pending}
            onClick={() => {
              setPrompt("dismiss");
              setError(null);
            }}
            variant="ghost"
            size="sm"
          >
            Descartar
          </OpButton>
        ) : null}
      </div>
      {error ? <p className="text-sm text-ln-op-danger">{error}</p> : null}
    </div>
  );
}
