"use client";

// AcceptButton — calls acceptInvitationAction and redirects to the org portal on success.

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { LnButton } from "@/components/ui/Button";
import { acceptInvitationAction } from "@/src/modules/organizations/actions";

type Props = {
  invitationToken: string;
};

export function AcceptButton({ invitationToken }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleAccept() {
    setError(null);
    startTransition(async () => {
      const result = await acceptInvitationAction({ invitationToken });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      router.push(`/org/${result.orgToken}`);
    });
  }

  return (
    <div className="space-y-2">
      {error && (
        <p className="text-sm text-[var(--color-ln-err)] text-center" role="alert">
          {error}
        </p>
      )}
      <LnButton
        type="button"
        variant="ok"
        loading={pending}
        onClick={handleAccept}
        className="w-full"
      >
        Aceptar invitación
      </LnButton>
    </div>
  );
}
