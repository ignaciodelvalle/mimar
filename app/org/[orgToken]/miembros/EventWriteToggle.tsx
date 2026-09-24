"use client";

// EventWriteToggle — toggle canWritePetEvents via setMemberEventWriteAction.

import { useState, useTransition } from "react";

import { Icon } from "@/components/Icon";
import { notifySaved } from "@/lib/ui/action-feedback";
import { setMemberEventWriteAction } from "@/src/modules/organizations/actions";

type Props = {
  organizationId: string;
  membershipId: string;
  canWrite: boolean;
};

export function EventWriteToggle({ organizationId, membershipId, canWrite }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Tier B optimistic toggle: local state seeded from the SSR prop is the
  // source of truth for this control; revert on error. No navigation —
  // router.refresh() is banned (silent-drop defect, see
  // lib/ui/full-page-action-nav.ts).
  const [write, setWrite] = useState(canWrite);

  function handleToggle() {
    setError(null);
    const next = !write;
    setWrite(next);
    startTransition(async () => {
      const result = await setMemberEventWriteAction({
        organizationId,
        membershipId,
        canWrite: next,
      });
      if ("error" in result) {
        setWrite(!next);
        setError(result.error);
      } else {
        notifySaved(
          next ? "Acceso a eventos clínicos habilitado" : "Acceso a eventos clínicos deshabilitado",
        );
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={handleToggle}
        disabled={pending}
        aria-pressed={write}
        title={write ? "Quitar acceso a eventos clínicos" : "Dar acceso a eventos clínicos"}
        className={[
          "rounded-[var(--radius-sm)] px-3 py-[5px] text-sm font-medium transition-colors disabled:opacity-60",
          write
            ? "border border-ln-op-ok-bd bg-ln-op-ok-bg text-ln-op-ok hover:bg-ln-op-ok hover:text-white"
            : "border border-ln-op-line text-ln-op-mute hover:bg-ln-op-stripe",
        ].join(" ")}
      >
        {pending ? (
          "..."
        ) : write ? (
          <span className="inline-flex items-center gap-1">
            Clínica <Icon name="check" size={13} decorative />
          </span>
        ) : (
          "Clínica"
        )}
      </button>
      {error && (
        <p className="text-sm text-ln-op-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
