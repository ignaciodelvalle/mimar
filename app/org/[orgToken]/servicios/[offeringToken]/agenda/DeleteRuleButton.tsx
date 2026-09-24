"use client";

// Confirm-gated delete for a schedule rule row (#815 audit finding #9).
//
// Previously a bare inline <form action={...}><button>Eliminar</button></form>
// with no confirmation — a single misclick removed a recurring availability
// rule with no "¿estás seguro?" step. Now uses the repo's shared ConfirmDialog
// (same component as CapabilityMatrix/AdoptionQueueList bulk-reject).
//
// deleteScheduleRuleAction already revalidates the agenda path server-side,
// but per lib/ui/full-page-action-nav.ts a full document reload — not
// router.refresh() — is the only navigation mechanism proven immune to the
// App Router's known post-action transition-drop defect.

import { useRef, useState, useTransition } from "react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

export function DeleteRuleButton({
  ruleId,
  orgToken,
  offeringToken,
  deleteAction,
}: {
  ruleId: string;
  orgToken: string;
  offeringToken: string;
  deleteAction: (
    ruleId: string,
    orgToken: string,
    offeringToken: string,
  ) => Promise<{ error: string | null }>;
}) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await deleteAction(ruleId, orgToken, offeringToken);
      if (result.error) {
        setError(result.error);
        return;
      }
      setOpen(false);
      navigateAfterActionSuccess(window.location.href);
    });
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm text-ln-op-danger hover:underline"
      >
        Eliminar
      </button>
      {error && <p className="mt-1 text-sm text-ln-op-danger">{error}</p>}
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={handleConfirm}
        title="¿Eliminar esta regla de agenda?"
        description="Los turnos ya materializados no se borran, pero no se generarán más turnos nuevos con esta regla. Esta acción no se puede deshacer."
        confirmLabel="Eliminar"
        tone="danger"
        pending={pending}
        triggerRef={triggerRef}
      />
    </>
  );
}
