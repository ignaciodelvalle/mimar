"use client";

// Manual-retry button for a single outbox row (Cowork A1 / operator-trust T0-T1).
//
// The retry action gave zero feedback: it reset next_retry_at/status server-side
// but the page didn't refresh and nothing confirmed the click, so an operator
// re-clicked thinking it had failed.
//
// FEEDBACK CONTRACT (T0): pending label while the action runs, then a VISIBLE
// state change. We reload the detail via navigateAfterActionSuccess (a full
// document navigation to the SAME page). That re-renders every server field at
// once — Estado, Intentos, Próximo reintento, and the SLA-breach banner — so
// nothing on screen contradicts the outcome. An optimistic in-place update was
// tried and rejected: it left the surrounding SSR fields (status badge, SLA
// banner) showing the OLD "Fallida" while the button claimed success — the exact
// "did it work?" confusion this fix exists to remove.
//
// T1 — the retry must never SILENTLY dump a valid session to /login. A full
// document navigation re-runs the layout auth guard: a valid session stays on
// the detail page; only a genuinely dead session lands on /login, which is the
// correct outcome (the operator must re-authenticate) — not a silent mid-action
// bounce. An error keeps the operator on the page with an inline message.

import { useState, useTransition } from "react";

import { OpButton } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

import { retryOutboxRowAction } from "../actions";

export function RetryOutboxButton({ rowId }: { rowId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await retryOutboxRowAction(rowId);
      if (result.error) {
        // Error stays on the page (T1): never a silent redirect.
        setError(result.error);
        return;
      }
      // Reload the detail so every server field (Estado, Intentos, Próximo
      // reintento, SLA banner) reflects the new schedule together — the visible
      // change IS the confirmation. The action already revalidated the path.
      navigateAfterActionSuccess(`/admin/outbox/${rowId}`);
    });
  }

  return (
    <span className="mt-2 block space-y-2">
      <OpButton type="button" variant="primary" onClick={submit} disabled={pending}>
        {pending ? "Programando…" : "Reintentar ahora"}
      </OpButton>
      {error && <output className="block text-sm text-ln-op-danger">{error}</output>}
    </span>
  );
}
