"use client";

import { useState, useTransition } from "react";

import { LnCheckbox } from "@/components/ui/Field";
import { OpButton, OpTextarea } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import {
  approveDenunciaModerationAction,
  escalateDenunciaToAdminAction,
  rejectDenunciaAsAbuseAction,
} from "@/src/modules/welfare/actions";

// Govt-scoped denuncia moderation triage (SDD phase 2):
//   approve  → pass to triage (the welfare case proceeds in /gob/maltrato)
//   reject   → confirm as abuse/spam (status=invalid, PERMANENT — needs ack)
//   escalate → hand back to the national admin queue with a motivo
type Mode = "none" | "approve" | "reject" | "escalate";

const MIN_NOTES = 10;

export function GovtModerationActions({ welfareReportId }: { welfareReportId: string }) {
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<Mode>("none");
  const [notes, setNotes] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setMode("none");
    setNotes("");
    setAcknowledged(false);
    setError(null);
  }

  function submit() {
    setError(null);
    const action =
      mode === "approve"
        ? () => approveDenunciaModerationAction({ welfareReportId, notes })
        : mode === "reject"
          ? () => rejectDenunciaAsAbuseAction({ welfareReportId, notes })
          : () => escalateDenunciaToAdminAction({ welfareReportId, notes });
    startTransition(async () => {
      const result = await action();
      if ("error" in result) {
        setError(result.error);
        return;
      }
      reset();
      // One full document navigation back to the queue — immune to the
      // double-transition silent-drop vector (see lib/ui/full-page-action-nav.ts).
      // F1 fusion (2026-07-22): Moderación is now a stage of the Denuncias
      // hub — navigate straight there instead of through the old
      // /gob/moderacion redirect.
      navigateAfterActionSuccess("/gob/denuncias?etapa=moderacion");
    });
  }

  if (mode === "none") {
    return (
      <div className="flex flex-wrap gap-2">
        <OpButton type="button" onClick={() => setMode("approve")} variant="ok" size="sm">
          Aprobar (pasar a triage)
        </OpButton>
        <OpButton type="button" onClick={() => setMode("reject")} variant="danger" size="sm">
          Rechazar como abuso
        </OpButton>
        <OpButton type="button" onClick={() => setMode("escalate")} variant="ghost" size="sm">
          Escalar a la administración
        </OpButton>
      </div>
    );
  }

  const title =
    mode === "approve"
      ? "Aprobar y pasar a triage"
      : mode === "reject"
        ? "Rechazar como abuso"
        : "Escalar a la administración";

  const placeholder =
    mode === "approve"
      ? "Por qué considerás que es legítima a pesar del flag (mínimo 10 caracteres)."
      : mode === "reject"
        ? "Por qué confirmás que es abuso o spam — patrón observado, frecuencia, etc. (mínimo 10)."
        : "Por qué la escalás a la administración nacional — jurisdicción ambigua, cruce de jurisdicciones, etc. (mínimo 10).";

  // Verb of the act per mode, never "Confirmar" (D.3, 2026-07-30). The three
  // modes are three different outcomes for a denuncia; a single generic word on
  // the commit button erased the difference at the exact moment it mattered.
  const submitLabel =
    mode === "approve"
      ? "Aprobar y pasar a triage"
      : mode === "reject"
        ? "Rechazar como abuso"
        : "Escalar a la administración";

  const notesOk = notes.trim().length >= MIN_NOTES;
  const canSubmit = mode === "reject" ? notesOk && acknowledged : notesOk;

  const submitVariant = mode === "reject" ? "danger" : mode === "approve" ? "ok" : "primary";

  return (
    <div className="space-y-3">
      <p className="text-md font-semibold text-ln-op-ink">{title}</p>

      {/* Explicit irreversibility warning before rejecting as abuse. */}
      {mode === "reject" && (
        <div className="space-y-2 rounded-[var(--radius-md)] border border-ln-op-danger-bd bg-ln-op-danger-bg p-3">
          <p className="text-sm font-semibold text-ln-op-danger">
            {
              "Rechazar como abuso marca la denuncia como inválida de forma permanente. No se puede deshacer."
            }
          </p>
          <LnCheckbox
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            labelClassName="text-xs! text-ln-op-danger!"
          >
            {
              "Entiendo que esta acción es irreversible y deja la denuncia inválida en el historial."
            }
          </LnCheckbox>
        </div>
      )}

      <OpTextarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={4}
        placeholder={placeholder}
        size="sm"
      />
      <p className="text-sm tabular-nums text-ln-op-mute">{notes.trim().length} caracteres</p>
      {error && <output className="block text-sm text-ln-op-danger">{error}</output>}
      <div className="flex gap-2">
        <OpButton
          type="button"
          onClick={submit}
          disabled={pending || !canSubmit}
          variant={submitVariant}
        >
          {pending ? "Procesando..." : submitLabel}
        </OpButton>
        <OpButton type="button" onClick={reset} disabled={pending} variant="ghost">
          Cancelar
        </OpButton>
      </div>
    </div>
  );
}
