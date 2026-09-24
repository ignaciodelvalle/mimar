"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { OpButton, OpInput, OpSelect, OpTextarea } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { setAdoptionEligibilityAction } from "@/src/modules/adoption/actions";

const REASONS = [
  { value: "medical_treatment", label: "Tratamiento médico en curso" },
  { value: "behavioral_evaluation", label: "Evaluación de comportamiento" },
  { value: "recovery", label: "Recuperación" },
  { value: "quarantine", label: "Cuarentena" },
  { value: "legal_hold", label: "Retención legal" },
  { value: "age", label: "Edad" },
  { value: "pending_intake_eval", label: "Evaluación de intake pendiente" },
  { value: "other", label: "Otro (especificar)" },
] as const;

type Reason = (typeof REASONS)[number]["value"];

export function EligibilityForm({
  petPublicToken,
  orgToken,
  current,
}: {
  petPublicToken: string;
  orgToken: string;
  current: {
    eligible: boolean | null;
    reason: string | null;
    notes: string | null;
    until: string | null;
  };
}) {
  // Router kept ONLY for the Cancelar button's plain (pre-mutation)
  // navigation; post-success navigation uses navigateAfterActionSuccess.
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [decision, setDecision] = useState<"eligible" | "not_eligible">(
    current.eligible === true
      ? "eligible"
      : current.eligible === false
        ? "not_eligible"
        : "eligible",
  );
  const [reason, setReason] = useState<Reason>(
    (current.reason as Reason | null) ?? "medical_treatment",
  );
  const [notes, setNotes] = useState(current.notes ?? "");
  const [until, setUntil] = useState(current.until ?? "");
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);

  function submit() {
    setError(null);
    setOkMessage(null);
    const eligible = decision === "eligible";
    startTransition(async () => {
      const result = await setAdoptionEligibilityAction({
        // Pin the action to the org in the URL. Without this the action falls
        // back to the session-default membership and, for a multi-org member,
        // writes against the wrong org — see setAdoptionEligibilityAction.
        orgToken,
        petPublicToken,
        eligible,
        ineligibleReason: eligible ? null : reason,
        ineligibleReasonNotes: eligible ? null : notes.trim() || null,
        ineligibleUntilIso: eligible || !until ? null : new Date(until).toISOString(),
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOkMessage(
        eligible
          ? "Marcada como apta para adopción."
          : "Marcada como NO apta. Resolvé el motivo cuando corresponda.",
      );
      // Full document reload so the SSR "Estado actual" block matches the DB
      // (router.refresh() is banned — see lib/ui/full-page-action-nav.ts).
      navigateAfterActionSuccess(window.location.href);
    });
  }

  return (
    <div className="space-y-4">
      <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-3 text-md">
        <p className="text-ln-op-ink-2">
          Estado actual:{" "}
          <strong className="text-ln-op-ink">
            {current.eligible === true
              ? "Apta"
              : current.eligible === false
                ? "NO apta"
                : "Sin determinar"}
          </strong>
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-ln-op-ink">Decisión</p>
        <div className="flex gap-2">
          <OpButton
            type="button"
            size="sm"
            variant={decision === "eligible" ? "ok" : "ghost"}
            onClick={() => setDecision("eligible")}
          >
            Apta para adopción
          </OpButton>
          <OpButton
            type="button"
            size="sm"
            variant={decision === "not_eligible" ? "primary" : "ghost"}
            onClick={() => setDecision("not_eligible")}
          >
            NO apta
          </OpButton>
        </div>
      </div>

      {decision === "not_eligible" && (
        <div className="space-y-3">
          <div>
            <label htmlFor="elig-reason" className="block text-sm font-medium text-ln-op-ink mb-1">
              Motivo
            </label>
            <OpSelect
              id="elig-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value as Reason)}
            >
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </OpSelect>
          </div>
          <div>
            <label htmlFor="elig-notes" className="block text-sm font-medium text-ln-op-ink mb-1">
              Notas {reason === "other" && <span className="text-ln-op-danger">*</span>}
            </label>
            <OpTextarea
              id="elig-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder={reason === "other" ? "Describí el motivo" : "Notas (opcional)"}
            />
          </div>
          <div>
            <label htmlFor="elig-until" className="block text-sm font-medium text-ln-op-ink mb-1">
              Hasta (opcional)
            </label>
            <OpInput
              id="elig-until"
              type="date"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              block={false}
            />
            <p className="text-sm text-ln-op-mute mt-1">
              Si lo dejás vacío, queda no-apta hasta que la marques manualmente otra vez.
            </p>
          </div>
        </div>
      )}

      {error && <output className="block text-sm text-ln-op-danger">{error}</output>}
      {okMessage && <output className="block text-sm text-ln-op-ok">{okMessage}</output>}

      <div className="flex gap-2">
        <OpButton type="button" onClick={submit} disabled={pending}>
          {pending ? "Guardando..." : "Confirmar elegibilidad"}
        </OpButton>
        <OpButton
          type="button"
          variant="ghost"
          onClick={() => router.push(`/org/${orgToken}/mascotas`)}
          disabled={pending}
        >
          Cancelar
        </OpButton>
      </div>
    </div>
  );
}
