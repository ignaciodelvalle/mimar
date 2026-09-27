"use client";

// The /admin/designaciones forms (SDD jurisdiction-admin, Phase 3):
// designate a jurisdiction administrator for a province, and revoke a
// designation. Presentational: every datum arrives as props from the page
// (the container); the only thing these components call is the server action.
//
// Both acts ask for a reason — it is what the audit history shows next to who
// and when. After a success the page reloads as a full document navigation
// (navigateAfterActionSuccess) — never router.refresh, which the App Router
// can silently drop (lint:nav).

import { useState, useTransition } from "react";

import {
  appointJurisdictionAdminAction,
  revokeJurisdictionAdminAction,
} from "@/app/actions/jurisdiction-admin";
import { OpButton, OpField, OpFormAlert, OpSelect, OpTextarea } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

import { designationErrorMessage } from "./designation-errors";

export type CandidateOption = {
  userId: string;
  label: string;
};

function useDesignationAction(provinceName: string) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  function run(action: () => Promise<{ ok: true } | { error: string }>, successUrl: string) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if ("error" in result) {
        setError(designationErrorMessage(result.error, provinceName));
        return;
      }
      navigateAfterActionSuccess(successUrl);
    });
  }
  return { error, pending, run };
}

/** Designate one of the province's funcionarios as its administrator. */
export function AppointForm({
  provinceCode,
  provinceName,
  candidates,
}: {
  provinceCode: string;
  provinceName: string;
  candidates: CandidateOption[];
}) {
  const [userId, setUserId] = useState("");
  const [reason, setReason] = useState("");
  const { error, pending, run } = useDesignationAction(provinceName);
  const canSubmit = userId !== "" && reason.trim() !== "" && !pending;

  if (candidates.length === 0) {
    return (
      <p className="text-sm text-ln-op-mute">
        Nadie se puede designar todavía: hace falta un funcionario de gobierno activo con
        concesiones solo en {provinceName}. Asignale la provincia desde Cuentas privilegiadas.
      </p>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        run(
          () => appointJurisdictionAdminAction({ userId, provinceCode, reason }),
          `/admin/designaciones?provincia=${provinceCode}`,
        );
      }}
    >
      <OpField
        label="Funcionario"
        hint={`Pasa a administrar funcionarios, unidades y reglas de ${provinceName}, y solo de ${provinceName}.`}
      >
        {({ id, describedBy }) => (
          <OpSelect
            id={id}
            aria-describedby={describedBy}
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          >
            <option value="">Elegí un funcionario…</option>
            {candidates.map((c) => (
              <option key={c.userId} value={c.userId}>
                {c.label}
              </option>
            ))}
          </OpSelect>
        )}
      </OpField>
      <OpField label="Motivo" required>
        {({ id, describedBy }) => (
          <OpTextarea
            id={id}
            aria-describedby={describedBy}
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </OpField>
      {error && <OpFormAlert>{error}</OpFormAlert>}
      <OpButton type="submit" disabled={!canSubmit} loading={pending}>
        Designar administrador/a jurisdiccional
      </OpButton>
    </form>
  );
}

/** End a designation. The reason is required. */
export function RevokeForm({
  appointmentId,
  provinceCode,
  provinceName,
  displayName,
}: {
  appointmentId: string;
  provinceCode: string;
  provinceName: string;
  displayName: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { error, pending, run } = useDesignationAction(provinceName);

  if (!open) {
    return (
      <OpButton type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Revocar designación
      </OpButton>
    );
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim() === "" || pending) return;
        run(
          () => revokeJurisdictionAdminAction({ appointmentId, reason }),
          `/admin/designaciones?provincia=${provinceCode}`,
        );
      }}
    >
      <OpField
        label={`Motivo para revocar a ${displayName}`}
        hint="Deja de administrar la provincia en el acto. Si la designación le dio la provincia entera, también la pierde."
        required
      >
        {({ id, describedBy }) => (
          <OpTextarea
            id={id}
            aria-describedby={describedBy}
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </OpField>
      {error && <OpFormAlert>{error}</OpFormAlert>}
      <div className="flex gap-2">
        <OpButton type="submit" disabled={reason.trim() === "" || pending} loading={pending}>
          Revocar designación
        </OpButton>
        <OpButton type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancelar
        </OpButton>
      </div>
    </form>
  );
}
