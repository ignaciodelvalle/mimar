"use client";

import { useState, useTransition } from "react";

import { LnCheckbox } from "@/components/ui/Field";
import { OpButton, OpTextarea } from "@/components/ui/dashboard";
import { canSubmitModeration } from "@/lib/domain/destructive-confirmation";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import {
  confirmWelfareAsSpamAction,
  passWelfareToTriageAction,
} from "@/src/modules/welfare/actions";

type Mode = "none" | "pass" | "spam";

export function ModerationActions({ welfareReportId }: { welfareReportId: string }) {
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
      mode === "pass"
        ? () => passWelfareToTriageAction({ welfareReportId, notes })
        : () => confirmWelfareAsSpamAction({ welfareReportId, notes });
    startTransition(async () => {
      const result = await action();
      if ("error" in result) {
        setError(result.error);
        return;
      }
      reset();
      // The cross-route push + refresh pair was a classic silent-drop vector
      // (double transition). One full document navigation back to the queue
      // is immune and lands on fresh SSR — see lib/ui/full-page-action-nav.ts.
      navigateAfterActionSuccess("/admin/moderacion");
    });
  }

  if (mode === "none") {
    return (
      <div className="flex flex-wrap gap-2">
        <OpButton type="button" onClick={() => setMode("pass")} variant="ok" size="sm">
          Pasar a triage
        </OpButton>
        <OpButton type="button" onClick={() => setMode("spam")} variant="danger" size="sm">
          Marcar como spam
        </OpButton>
      </div>
    );
  }

  // Verb of the act on the commit button, never "Confirmar" (D.3, 2026-07-30).
  // "Confirmar como spam" was banned too: the leading verb described the click,
  // not the outcome — the act is MARKING the denuncia as spam.
  const title = mode === "pass" ? "Pasar a triage" : "Marcar como spam";
  const submitLabel = mode === "pass" ? "Pasar a triage" : "Marcar como spam";
  const placeholder =
    mode === "pass"
      ? "Por qué considerás que es legítima a pesar del flag (mínimo 10 caracteres)."
      : "Por qué confirmás que es spam — pattern observado, frecuencia, etc. (mínimo 10).";

  const canSubmit = canSubmitModeration({ mode, notes, acknowledged });

  return (
    <div className="space-y-3">
      <p className="text-md font-semibold text-ln-op-ink">{title}</p>

      {/* C7 — explicit irreversibility warning before confirming spam. */}
      {mode === "spam" && (
        <div className="space-y-2 rounded-[var(--radius-md)] border border-ln-op-danger-bd bg-ln-op-danger-bg p-3">
          <p className="text-sm font-semibold text-ln-op-danger">
            {
              "Marcar como spam deja la denuncia como inválida de forma permanente. No se puede deshacer."
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
          variant={mode === "pass" ? "ok" : "danger"}
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
