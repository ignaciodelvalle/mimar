"use client";

import { useState, useTransition } from "react";

import { OpButton, OpTextarea } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import {
  closeWelfareReportAction,
  startWelfareReportAction,
  triageWelfareReportAction,
} from "@/src/modules/welfare/actions";
import type { WelfareReportStatus } from "@/src/modules/welfare/domain/types";

type Mode = "none" | "triage" | "invalid" | "duplicate" | "start" | "close";

export function TriageActions({
  welfareReportId,
  currentStatus,
}: {
  welfareReportId: string;
  currentStatus: WelfareReportStatus;
}) {
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<Mode>("none");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setMode("none");
    setNotes("");
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
    if (mode === "triage") {
      run(() => triageWelfareReportAction({ welfareReportId, decision: "triaged", notes }));
    } else if (mode === "invalid") {
      run(() => triageWelfareReportAction({ welfareReportId, decision: "invalid", notes }));
    } else if (mode === "duplicate") {
      run(() => triageWelfareReportAction({ welfareReportId, decision: "duplicate", notes }));
    } else if (mode === "start") {
      run(() => startWelfareReportAction({ welfareReportId, notes }));
    } else if (mode === "close") {
      run(() => closeWelfareReportAction({ welfareReportId, resolutionNotes: notes }));
    }
  }

  // Action set per current status. The server enforces the same matrix —
  // this just hides the buttons that the server would reject anyway.
  const canTriage = currentStatus === "open";
  const canMarkInvalidOrDuplicate = currentStatus === "open" || currentStatus === "triaged";
  const canStart = currentStatus === "open" || currentStatus === "triaged";
  const canClose =
    currentStatus === "open" || currentStatus === "triaged" || currentStatus === "in_progress";

  if (mode === "none") {
    return (
      <div className="flex flex-wrap gap-2">
        {canTriage && (
          <OpButton type="button" onClick={() => setMode("triage")} variant="primary" size="sm">
            Marcar revisada
          </OpButton>
        )}
        {canStart && (
          <OpButton type="button" onClick={() => setMode("start")} variant="primary" size="sm">
            Iniciar seguimiento
          </OpButton>
        )}
        {canClose && (
          <OpButton type="button" onClick={() => setMode("close")} variant="ok" size="sm">
            Cerrar con resolución
          </OpButton>
        )}
        {canMarkInvalidOrDuplicate && (
          <>
            <OpButton type="button" onClick={() => setMode("invalid")} variant="ghost" size="sm">
              Sin sustento
            </OpButton>
            <OpButton type="button" onClick={() => setMode("duplicate")} variant="ghost" size="sm">
              Duplicada
            </OpButton>
          </>
        )}
      </div>
    );
  }

  const titles: Record<Exclude<Mode, "none">, string> = {
    triage: "Marcar como revisada",
    start: "Iniciar seguimiento",
    close: "Cerrar con resolución",
    invalid: "Cerrar por falta de sustento",
    duplicate: "Marcar como duplicada",
  };

  // The confirm button carries the verb of the act, never "Confirmar" (D.3,
  // 2026-07-30). One label per mode — the five modes are five different acts
  // and a single generic word made them indistinguishable at the moment of
  // committing.
  const submitLabels: Record<Exclude<Mode, "none">, string> = {
    triage: "Marcar revisada",
    start: "Iniciar seguimiento",
    close: "Cerrar con resolución",
    invalid: "Cerrar sin sustento",
    duplicate: "Marcar duplicada",
  };

  const placeholders: Record<Exclude<Mode, "none">, string> = {
    triage: "Notas internas del triage (mínimo 10 caracteres)",
    start: "Notas del inicio del seguimiento (mínimo 10 caracteres)",
    close:
      "Resolución final — qué se hizo, a quién se derivó, cualquier acción institucional. Mínimo 10 caracteres.",
    invalid: "Motivo por el que la denuncia no tiene sustento (mínimo 10 caracteres)",
    duplicate:
      "Indicá qué denuncia previa la duplica (referencia, código, contexto). Mínimo 10 caracteres.",
  };

  return (
    <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4 space-y-3">
      <p className="text-md font-medium text-ln-op-ink">{titles[mode]}</p>
      <OpTextarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={4}
        placeholder={placeholders[mode]}
      />
      <p className="text-sm text-ln-op-mute tabular-nums">{notes.trim().length} caracteres</p>
      {error && <output className="block text-sm text-ln-op-danger">{error}</output>}
      <div className="flex gap-2">
        <OpButton
          type="button"
          onClick={submit}
          disabled={pending || notes.trim().length < 10}
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
