"use client";

// "Materializar ahora" button — org agenda page (Fase 3).
//
// Calls materializeOfferingNowAction(offeringToken) and shows a result toast.
// This is a thin client wrapper; the real work happens in the server action.

import { useState, useTransition } from "react";

import type { MaterializeNowResult } from "@/app/actions/slot-materialization";
import { OpButton } from "@/components/ui/dashboard";

type Props = {
  offeringToken: string;
  materializeAction: (token: string) => Promise<MaterializeNowResult>;
};

export function MaterializeNowButton({ offeringToken, materializeAction }: Props) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  function handleClick() {
    setMessage(null);
    startTransition(async () => {
      const result = await materializeAction(offeringToken);
      if ("error" in result) {
        setMessage({ text: result.error, ok: false });
      } else {
        const { rulesProcessed, slotsInserted } = result;
        setMessage({
          text: `Listo. Reglas procesadas: ${rulesProcessed}. Turnos nuevos: ${slotsInserted}.`,
          ok: true,
        });
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <OpButton variant="primary" size="sm" onClick={handleClick} disabled={isPending}>
        {isPending ? "Materializando…" : "Materializar ahora"}
      </OpButton>
      {message && (
        <p className={`text-sm ${message.ok ? "text-ln-op-ok" : "text-ln-op-danger"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
