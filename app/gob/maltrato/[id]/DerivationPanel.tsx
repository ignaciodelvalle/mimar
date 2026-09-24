"use client";

import { useState, useTransition } from "react";

import { OpButton, OpSelect } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { AR_TIME_ZONE } from "@/lib/utils/format";
import { deriveWelfareToOrgAction } from "@/src/modules/welfare/actions";

type OrgOption = {
  id: string;
  displayName: string;
  orgType: string;
};

type DerivationPanelProps = {
  welfareReportId: string;
  availableOrgs: OrgOption[];
  alreadyDerivedTo: { orgId: string; orgDisplayName: string; derivedAt: Date } | null;
};

export function DerivationPanel({
  welfareReportId,
  availableOrgs,
  alreadyDerivedTo,
}: DerivationPanelProps) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [selectedOrgId, setSelectedOrgId] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleConfirm() {
    if (!selectedOrgId) return;
    setError(null);
    startTransition(async () => {
      const result = await deriveWelfareToOrgAction({
        welfareReportId,
        targetOrgId: selectedOrgId,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setSelectedOrgId("");
      // Full document reload so the SSR page reflects the mutation
      // (router.refresh() is banned - see lib/ui/full-page-action-nav.ts).
      navigateAfterActionSuccess(window.location.href);
    });
  }

  if (!open) {
    return (
      <div className="flex items-center gap-3 flex-wrap">
        {alreadyDerivedTo && (
          <p className="text-sm text-ln-op-mute">
            Ya derivada a{" "}
            <span className="font-medium text-ln-op-ink-2">{alreadyDerivedTo.orgDisplayName}</span>
            {" — "}
            <span>
              {new Date(alreadyDerivedTo.derivedAt).toLocaleDateString("es-AR", {
                day: "numeric",
                month: "short",
                year: "numeric",
                timeZone: AR_TIME_ZONE,
              })}
            </span>
          </p>
        )}
        <OpButton type="button" onClick={() => setOpen(true)} variant="primary" size="sm">
          {alreadyDerivedTo ? "Cambiar derivación" : "Derivar a org"}
        </OpButton>
      </div>
    );
  }

  return (
    <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4 space-y-3">
      <p className="text-md font-medium text-ln-op-ink">Derivar a refugio u org de rescate</p>
      {availableOrgs.length === 0 ? (
        <p className="text-sm text-ln-op-mute">
          No hay refugios ni redes de rescate verificados disponibles.
        </p>
      ) : (
        <OpSelect value={selectedOrgId} onChange={(e) => setSelectedOrgId(e.target.value)}>
          <option value="">Seleccioná una organización…</option>
          {availableOrgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.displayName} ({o.orgType === "shelter" ? "Refugio" : "Red de rescate"})
            </option>
          ))}
        </OpSelect>
      )}
      {error && <output className="block text-sm text-ln-op-danger">{error}</output>}
      <div className="flex gap-2">
        <OpButton
          type="button"
          onClick={handleConfirm}
          disabled={pending || !selectedOrgId}
          variant="primary"
          className="px-4 py-2"
        >
          {pending ? "Procesando..." : "Derivar"}
        </OpButton>
        <OpButton
          type="button"
          onClick={() => {
            setOpen(false);
            setSelectedOrgId("");
            setError(null);
          }}
          disabled={pending}
          variant="ghost"
          className="px-4 py-2"
        >
          Cancelar
        </OpButton>
      </div>
    </div>
  );
}
