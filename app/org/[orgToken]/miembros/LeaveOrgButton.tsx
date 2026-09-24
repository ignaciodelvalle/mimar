"use client";

// LeaveOrgButton — lets the current user leave the organization (self-leave path).

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { OpButton } from "@/components/ui/dashboard";
import { leaveOrganizationAction } from "@/src/modules/organizations/actions";

type Props = {
  organizationId: string;
  isLastAdmin: boolean;
};

export function LeaveOrgButton({ organizationId, isLastAdmin }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function handleLeave() {
    setError(null);
    startTransition(async () => {
      const result = await leaveOrganizationAction({ organizationId });
      if ("error" in result) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      router.push("/");
    });
  }

  if (isLastAdmin) {
    return (
      <OpButton
        variant="ghost"
        size="sm"
        disabled
        title="Sos el único administrador. Asigná otro administrador antes de salir."
      >
        Salir de la organización
      </OpButton>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-[var(--radius-sm)] border border-ln-op-line px-3 py-[5px] text-sm font-medium text-ln-op-ink transition-colors hover:bg-ln-op-stripe"
      >
        Salir de la organización
      </button>
      {error && (
        <p className="text-sm text-ln-op-danger" role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={handleLeave}
        title="¿Salir de la organización?"
        description="Vas a dejar de tener acceso a la organización. Podés ser invitado nuevamente en el futuro."
        confirmLabel="Salir"
        tone="warn"
        pending={pending}
        triggerRef={triggerRef}
      />
    </div>
  );
}
