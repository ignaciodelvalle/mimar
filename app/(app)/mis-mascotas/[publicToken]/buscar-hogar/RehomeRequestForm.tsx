"use client";

// RehomeRequestForm — per-org "Enviar solicitud" button on the buscar-hogar page.
// Calls sendRehomeRequestAction; shows pending/sent/error states.

import { useTransition } from "react";

type Props = {
  petPublicToken: string;
  targetOrgId: string;
  orgDisplayName: string;
  fosterName: string;
};

import { useState } from "react";

import { Icon } from "@/components/Icon";
import { notifySaved } from "@/lib/ui/action-feedback";

export function RehomeRequestForm({ petPublicToken, targetOrgId, orgDisplayName }: Props) {
  const [isPending, startTransition] = useTransition();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleSend() {
    startTransition(async () => {
      setError(null);
      const { sendRehomeRequestAction } = await import("@/src/modules/foster/actions");
      const result = await sendRehomeRequestAction(petPublicToken, targetOrgId);
      if ("error" in result) {
        setError(result.error);
      } else {
        setSent(true);
        notifySaved("Solicitud enviada");
      }
    });
  }

  if (sent) {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-[var(--color-ln-ok)] font-medium whitespace-nowrap">
        <Icon name="check" size={14} decorative /> Solicitud enviada a {orgDisplayName}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={handleSend}
        disabled={isPending}
        className="px-3 py-1.5 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] text-white text-sm font-medium hover:bg-[var(--color-ln-azul-700)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed whitespace-nowrap"
      >
        {isPending ? "Enviando…" : "Enviar solicitud"}
      </button>
      {error && <p className="text-xs text-[var(--color-ln-err)]">{error}</p>}
    </div>
  );
}
