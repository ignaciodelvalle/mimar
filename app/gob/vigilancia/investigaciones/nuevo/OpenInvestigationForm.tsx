"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { OpButton, OpInput, OpSelect, OpTextarea } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { openOutbreakInvestigationAction } from "@/src/modules/surveillance/actions";
import type { EnoDisease } from "@/src/modules/surveillance/domain/eno-catalog";

export function OpenInvestigationForm({
  diseases,
  prefillDiseaseCode,
  prefillSignalId,
}: {
  diseases: readonly EnoDisease[];
  prefillDiseaseCode?: string;
  prefillSignalId?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [submitted, setSubmitted] = useState(false);
  const [diseaseCode, setDiseaseCode] = useState(prefillDiseaseCode ?? "");
  const [reason, setReason] = useState("");
  const [signalId, setSignalId] = useState(prefillSignalId ?? "");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending || submitted) return; // guard against double-submit
    setError(null);
    startTransition(async () => {
      const result = await openOutbreakInvestigationAction({
        diseaseCode,
        reason,
        linkedSignalEventId: signalId.trim() || null,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      // Full-document navigation (redirectTo contract) — immune to the Next.js
      // 15.5 router-drop defect that silently no-ops router.push and lets the
      // officer re-submit into a duplicate investigation (nav #46 burn-down).
      setSubmitted(true);
      navigateAfterActionSuccess(`/gob/vigilancia/investigaciones/${result.publicCode}`);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-1.5">
        <label htmlFor="diseaseCode" className="block text-md font-medium text-ln-op-ink">
          Enfermedad (ENO)
        </label>
        <OpSelect
          id="diseaseCode"
          value={diseaseCode}
          onChange={(e) => setDiseaseCode(e.target.value)}
          required
        >
          <option value="">Seleccionar enfermedad...</option>
          {diseases.map((d) => (
            <option key={d.code} value={d.code}>
              {d.label} — {d.severity === "critical" ? "crítica" : "alta"} ({d.notifyHours}h)
            </option>
          ))}
        </OpSelect>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="reason" className="block text-md font-medium text-ln-op-ink">
          Motivo de apertura (mínimo 10 caracteres)
        </label>
        <OpTextarea
          id="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
          required
          minLength={10}
          placeholder="Describí la situación epidemiológica que motiva la apertura…"
        />
        <p className="text-sm text-ln-op-mute tabular-nums">{reason.trim().length} caracteres</p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="signalId" className="block text-md font-medium text-ln-op-ink">
          Signal vinculada (opcional)
        </label>
        <OpInput
          id="signalId"
          type="text"
          value={signalId}
          onChange={(e) => setSignalId(e.target.value)}
          placeholder="ID del outbreak_signal event (si existe)"
          className="font-ln-mono"
        />
      </div>

      {error && <output className="block text-md text-ln-op-danger">{error}</output>}

      <div className="flex gap-3">
        <OpButton
          type="submit"
          disabled={pending || submitted || !diseaseCode || reason.trim().length < 10}
          variant="primary"
          className="px-4 py-2"
        >
          {pending || submitted ? "Abriendo..." : "Abrir investigación"}
        </OpButton>
        <OpButton
          type="button"
          onClick={() => router.back()}
          disabled={pending}
          variant="ghost"
          className="px-4 py-2"
        >
          Cancelar
        </OpButton>
      </div>
    </form>
  );
}
