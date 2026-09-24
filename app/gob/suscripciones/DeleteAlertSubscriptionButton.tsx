"use client";

// C10 — 2-step inline confirmation for deleting an alert subscription.
//
// Moved from app/admin/programa/ (2026-07-21, page promotion): this is now
// used by the canonical /gob/suscripciones page (and by extension its
// /admin/suscripciones thin wrapper). The page is a server component; only
// this button is a client component. It posts to the existing
// deleteAlertSubscriptionAction server action via a plain <form>, gated
// behind an idle → confirming step (mirrors DeleteRuleButton's pattern). No
// reason capture — alert subscriptions are operator-owned config, not an
// audited destructive action.

import { useState } from "react";

import { deleteAlertSubscriptionAction } from "@/app/actions/alert-subscriptions";
import { OpButton } from "@/components/ui/dashboard";

export function DeleteAlertSubscriptionButton({ subscriptionId }: { subscriptionId: string }) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <OpButton
        type="button"
        onClick={() => setConfirming(true)}
        variant="danger"
        size="sm"
        aria-label="Eliminar suscripción"
        className="h-11 px-3"
      >
        Eliminar
      </OpButton>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <form action={deleteAlertSubscriptionAction}>
        <input type="hidden" name="id" value={subscriptionId} />
        <OpButton type="submit" variant="danger" size="sm" className="h-11 px-3">
          Eliminar suscripción
        </OpButton>
      </form>
      <OpButton
        type="button"
        onClick={() => setConfirming(false)}
        variant="ghost"
        size="sm"
        className="h-11 px-3"
      >
        Cancelar
      </OpButton>
    </div>
  );
}
