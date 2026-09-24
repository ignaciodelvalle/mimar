"use client";

import { useState, useTransition } from "react";

import { OpButton, OpInput, OpSelect, OpTextarea } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import {
  type InvestigationNoteEntryType,
  addInvestigationNoteAction,
  closeInvestigationAction,
  escalateInvestigationAction,
} from "@/src/modules/surveillance/actions";

type Mode =
  | "none"
  | "add_note"
  | "external_notification"
  | "escalate"
  | "close_resolved"
  | "close_dismissed";

const ENTRY_TYPES: { value: InvestigationNoteEntryType; label: string }[] = [
  { value: "classification", label: "Clasificacion de caso" },
  { value: "lab_result", label: "Resultado de laboratorio" },
  { value: "control_action", label: "Medida de control" },
  { value: "contact_tracing", label: "Rastreo de contactos" },
  { value: "final_report", label: "Informe epidemiológico final" },
  { value: "system", label: "Nota general" },
];

export function InvestigationActions({
  casePublicCode,
  currentStatus,
}: {
  casePublicCode: string;
  currentStatus: string;
}) {
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<Mode>("none");
  const [notes, setNotes] = useState("");
  const [finalReport, setFinalReport] = useState("");
  const [entryType, setEntryType] = useState<InvestigationNoteEntryType>("system");
  // External notification (UI-7 B9) — date + channel + reference audit trail.
  const [extDate, setExtDate] = useState("");
  const [extChannel, setExtChannel] = useState("");
  const [extReference, setExtReference] = useState("");
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setMode("none");
    setNotes("");
    setFinalReport("");
    setExtDate("");
    setExtChannel("");
    setExtReference("");
    setError(null);
  }

  function run(actionFn: () => Promise<{ ok: true } | { error: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await actionFn();
      if ("error" in result) {
        setError(result.error);
        return;
      }
      reset();
      // Full document reload so the SSR page reflects the mutation
      // (router.refresh() is banned - see lib/ui/full-page-action-nav.ts).
      navigateAfterActionSuccess(window.location.href);
    });
  }

  function submit() {
    if (mode === "add_note") {
      run(() => addInvestigationNoteAction({ casePublicCode, entryType, notes }));
    } else if (mode === "external_notification") {
      run(() =>
        addInvestigationNoteAction({
          casePublicCode,
          entryType: "external_notification",
          notes,
          payload: {
            notified_at: extDate.trim() || null,
            channel: extChannel.trim() || null,
            reference: extReference.trim() || null,
          },
        }),
      );
    } else if (mode === "escalate") {
      run(() => escalateInvestigationAction({ casePublicCode, reason: notes }));
    } else if (mode === "close_resolved") {
      run(() =>
        closeInvestigationAction({
          casePublicCode,
          outcome: "resolved",
          finalReportText: finalReport.trim() || null,
          reason: notes,
        }),
      );
    } else if (mode === "close_dismissed") {
      run(() =>
        closeInvestigationAction({
          casePublicCode,
          outcome: "dismissed",
          reason: notes,
        }),
      );
    }
  }

  const canEscalate = currentStatus === "open";
  const canClose = currentStatus === "open" || currentStatus === "escalated";

  if (mode === "none") {
    return (
      <div className="flex flex-wrap gap-2">
        <OpButton type="button" onClick={() => setMode("add_note")} variant="primary" size="sm">
          Registrar dato / nota
        </OpButton>
        <OpButton
          type="button"
          onClick={() => setMode("external_notification")}
          variant="ghost"
          size="sm"
        >
          Registrar notificación externa
        </OpButton>
        {canEscalate && (
          <OpButton type="button" onClick={() => setMode("escalate")} variant="danger" size="sm">
            Escalar
          </OpButton>
        )}
        {canClose && (
          <>
            <OpButton
              type="button"
              onClick={() => setMode("close_resolved")}
              variant="ok"
              size="sm"
            >
              Cerrar como resuelta
            </OpButton>
            <OpButton
              type="button"
              onClick={() => setMode("close_dismissed")}
              variant="ghost"
              size="sm"
            >
              Cerrar como desestimada
            </OpButton>
          </>
        )}
      </div>
    );
  }

  const titles: Record<Exclude<Mode, "none">, string> = {
    add_note: "Registrar dato epidemiológico o nota",
    external_notification: "Registrar notificación externa",
    escalate: "Escalar investigación",
    close_resolved: "Cerrar como resuelta",
    close_dismissed: "Cerrar como desestimada",
  };

  // Verb of the act per mode, never "Confirmar" (D.3, 2026-07-30). Shorter than
  // the panel titles above because these sit on a button next to "Cancelar".
  const submitLabels: Record<Exclude<Mode, "none">, string> = {
    add_note: "Registrar nota",
    external_notification: "Registrar notificación",
    escalate: "Escalar investigación",
    close_resolved: "Cerrar como resuelta",
    close_dismissed: "Cerrar como desestimada",
  };

  return (
    <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4 space-y-3">
      <p className="text-md font-medium text-ln-op-ink">{titles[mode]}</p>

      {mode === "add_note" && (
        <div className="space-y-1.5">
          <label htmlFor="entry-type" className="block text-sm font-medium text-ln-op-mute">
            Tipo de registro
          </label>
          <OpSelect
            id="entry-type"
            value={entryType}
            onChange={(e) => setEntryType(e.target.value as InvestigationNoteEntryType)}
          >
            {ENTRY_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </OpSelect>
        </div>
      )}

      {mode === "external_notification" && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="ext-date" className="block text-sm font-medium text-ln-op-mute">
              Fecha de notificación
            </label>
            <OpInput
              id="ext-date"
              type="date"
              value={extDate}
              onChange={(e) => setExtDate(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="ext-channel" className="block text-sm font-medium text-ln-op-mute">
              Canal
            </label>
            <OpInput
              id="ext-channel"
              type="text"
              value={extChannel}
              onChange={(e) => setExtChannel(e.target.value)}
              placeholder="SNVS / SENASA / zoonosis…"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="ext-reference" className="block text-sm font-medium text-ln-op-mute">
              Referencia (opcional)
            </label>
            <OpInput
              id="ext-reference"
              type="text"
              value={extReference}
              onChange={(e) => setExtReference(e.target.value)}
              placeholder="N.º de expediente / acta…"
            />
          </div>
        </div>
      )}

      {mode === "close_resolved" && (
        <div className="space-y-1.5">
          <label htmlFor="final-report" className="block text-sm font-medium text-ln-op-mute">
            Informe final (si no lo registraste antes)
          </label>
          <OpTextarea
            id="final-report"
            value={finalReport}
            onChange={(e) => setFinalReport(e.target.value)}
            rows={3}
            placeholder="Texto del informe epidemiológico final (opcional si ya existe un registro previo)…"
          />
        </div>
      )}

      <div className="space-y-1.5">
        <label htmlFor="notes" className="block text-sm font-medium text-ln-op-mute">
          {mode === "add_note"
            ? "Detalle (mínimo 5 caracteres)"
            : mode === "external_notification"
              ? "Detalle de la notificación (mínimo 5 caracteres)"
              : "Motivo (mínimo 10 caracteres)"}
        </label>
        <OpTextarea
          id="notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          placeholder={
            mode === "add_note"
              ? "Describi el hallazgo, resultado o medida registrada..."
              : mode === "external_notification"
                ? "A quien y que se notifico por el canal externo..."
                : "Explica el motivo..."
          }
        />
        <p className="text-sm text-ln-op-mute tabular-nums">{notes.trim().length} caracteres</p>
      </div>

      {error && <output className="block text-md text-ln-op-danger">{error}</output>}

      <div className="flex gap-2">
        <OpButton
          type="button"
          onClick={submit}
          disabled={
            pending ||
            (mode === "add_note" || mode === "external_notification"
              ? notes.trim().length < 5
              : notes.trim().length < 10)
          }
          variant="primary"
          className="px-4 py-2"
        >
          {pending ? "Procesando..." : submitLabels[mode]}
        </OpButton>
        <OpButton
          type="button"
          onClick={reset}
          disabled={pending}
          variant="ghost"
          className="px-4 py-2"
        >
          Cancelar
        </OpButton>
      </div>
    </div>
  );
}
