"use client";

// RemoveMemberButton — confirms and calls removeMemberAction for a member row.

import { useRef, useState, useTransition } from "react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { removeMemberAction } from "@/src/modules/organizations/actions";

type Props = {
  organizationId: string;
  membershipId: string;
  displayName: string;
};

export function RemoveMemberButton({ organizationId, membershipId, displayName }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function handleRemove() {
    setError(null);
    startTransition(async () => {
      const result = await removeMemberAction({ organizationId, membershipId });
      if ("error" in result) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      // Full document reload so the SSR member list drops the row
      // (router.refresh() is banned — see lib/ui/full-page-action-nav.ts).
      navigateAfterActionSuccess(window.location.href);
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-[var(--radius-sm)] border border-ln-op-danger px-3 py-[5px] text-sm font-medium text-ln-op-danger transition-colors hover:bg-ln-op-danger hover:text-white"
      >
        Quitar
      </button>
      {error && (
        <p className="text-sm text-ln-op-danger" role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={handleRemove}
        title={`¿Quitar a ${displayName} de la organización?`}
        description="Esta acción eliminará al miembro de la organización."
        confirmLabel="Quitar"
        tone="danger"
        pending={pending}
        triggerRef={triggerRef}
      />
    </div>
  );
}
