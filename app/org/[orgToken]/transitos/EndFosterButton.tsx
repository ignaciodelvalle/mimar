"use client";

import { useState, useTransition } from "react";

import { OpButton } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { type EndFosterFormState, endFosterAction } from "@/src/modules/foster/actions";

const SELECTABLE_END_REASONS = [
  { value: "returned", label: "Devolución normal" },
  { value: "early_return_by_foster", label: "Devolución anticipada por el foster" },
  { value: "lost_unrecovered", label: "Perdido sin recuperación" },
  { value: "other", label: "Otro (especificar en notas)" },
] as const;

type ReasonValue = (typeof SELECTABLE_END_REASONS)[number]["value"];

const fieldCls =
  "w-full rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-3 py-1.5 text-md text-ln-op-ink focus:outline-none focus:ring-1 focus:ring-ln-op-azul";

export function EndFosterButton({
  orgToken,
  publicToken,
}: {
  orgToken: string;
  publicToken: string;
}) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState<ReasonValue>("returned");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    const formData = new FormData();
    formData.set("reason", reason);
    formData.set("notes", notes);
    startTransition(async () => {
      const result: EndFosterFormState = await endFosterAction(
        orgToken,
        publicToken,
        { error: null },
        formData,
      );
      if (result.error) {
        setError(result.error);
      } else if (result.redirectTo) {
        // N3: the action names the destination and this navigates. It used to
        // redirect() server-side — a transition the App Router drops, so the
        // foster stay ENDED and the operator kept looking at the button.
        navigateAfterActionSuccess(result.redirectTo);
      }
    });
  }

  if (!open) {
    return (
      <OpButton variant="danger" size="sm" onClick={() => setOpen(true)} className="shrink-0">
        Finalizar tránsito
      </OpButton>
    );
  }

  return (
    <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-stripe p-3 space-y-2 w-full sm:w-80">
      <label htmlFor={`end-reason-${publicToken}`} className="block text-sm text-ln-op-mute">
        Motivo
      </label>
      <select
        id={`end-reason-${publicToken}`}
        value={reason}
        onChange={(e) => setReason(e.target.value as ReasonValue)}
        className={fieldCls}
      >
        {SELECTABLE_END_REASONS.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={2}
        placeholder="Notas (opcional)"
        aria-label="Notas"
        className={fieldCls}
      />
      {error && (
        <output className="block text-sm text-ln-op-danger" role="alert">
          {error}
        </output>
      )}
      {confirming ? (
        <div className="space-y-2">
          <p className="text-sm text-ln-op-ink-2">
            Esto cierra el tránsito y notifica al voluntario. ¿Confirmás?
          </p>
          <div className="flex gap-2">
            <OpButton variant="danger" size="sm" onClick={submit} disabled={pending}>
              {pending ? "Cerrando..." : "Finalizar tránsito"}
            </OpButton>
            <OpButton
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(false)}
              disabled={pending}
            >
              Atrás
            </OpButton>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <OpButton
            variant="danger"
            size="sm"
            onClick={() => setConfirming(true)}
            disabled={pending}
          >
            Finalizar tránsito
          </OpButton>
          <OpButton
            variant="ghost"
            size="sm"
            onClick={() => {
              setOpen(false);
              setConfirming(false);
            }}
            disabled={pending}
          >
            Cancelar
          </OpButton>
        </div>
      )}
    </div>
  );
}
