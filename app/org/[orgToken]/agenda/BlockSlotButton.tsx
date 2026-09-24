"use client";

// BlockSlotButton — confirms and triggers slot blocking for org agenda.
// Only rendered for slots with bookingsCount === 0 and status "open".

import { useState, useTransition } from "react";

import { blockSlotAction } from "@/app/actions/slot-materialization";
import { OpButton } from "@/components/ui/dashboard";
import { notifySaved } from "@/lib/ui/action-feedback";

type Props = {
  orgToken: string;
  slotId: string;
};

export function BlockSlotButton({ orgToken, slotId }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Tier B optimistic state: the cell flips to "Bloqueado" immediately and
  // reverts on error. No router.refresh() (banned — silent-drop defect, see
  // lib/ui/full-page-action-nav.ts); the SSR row status re-derives on the
  // next visit.
  const [blocked, setBlocked] = useState(false);

  function handleBlock() {
    setError(null);
    setConfirming(false);
    setBlocked(true);
    startTransition(async () => {
      const result = await blockSlotAction({ orgToken, slotId });
      if ("error" in result) {
        setBlocked(false);
        setError(result.error);
      } else {
        notifySaved("Cupo bloqueado");
      }
    });
  }

  if (blocked) {
    return (
      <span className="inline-flex items-center rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-stripe px-3 py-1 text-sm font-medium text-ln-op-mute">
        Bloqueado
      </span>
    );
  }

  if (!confirming) {
    return (
      <div className="flex flex-col gap-1">
        {/* Neutral OUTLINE, not danger (one-primary-per-screen review,
            2026-08-06): blocking a free cupo is routine capacity management
            and this trigger repeats once per slot row, so a solid red per row
            spent the screen's alarm budget on the least alarming action.
            Danger stays reserved for irreversible/destructive verbs. */}
        <OpButton variant="ghost" size="sm" onClick={() => setConfirming(true)}>
          Bloquear
        </OpButton>
        {error && (
          <p className="text-sm text-ln-op-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-ln-op-mute">¿Bloquear este cupo? Nadie va a poder reservarlo.</p>
      {error && (
        <p className="text-sm text-ln-op-danger" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <OpButton variant="primary" size="sm" onClick={handleBlock} disabled={pending}>
          {pending ? "Bloqueando..." : "Bloquear cupo"}
        </OpButton>
        <OpButton
          variant="ghost"
          size="sm"
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
          disabled={pending}
        >
          Cancelar
        </OpButton>
      </div>
    </div>
  );
}
