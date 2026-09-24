"use client";

import { useState, useTransition } from "react";

import { LnCheckbox } from "@/components/ui/Field";
import { LnSuccessScreen } from "@/components/ui/SuccessScreen";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import {
  acceptFosterProposalAction,
  rejectFosterProposalAction,
} from "@/src/modules/foster/actions";

const REJECTION_REASONS = [
  { value: "capacity", label: "No tengo capacity ahora" },
  { value: "health_mismatch", label: "No me siento preparado/a para esta condición" },
  { value: "timing", label: "Mal momento" },
  { value: "distance", label: "Muy lejos" },
  { value: "household", label: "Razones del hogar" },
  { value: "other", label: "Otro" },
] as const;

type RejectionReason = (typeof REJECTION_REASONS)[number]["value"];

export function ProposalActions({
  proposalPublicToken,
  petName,
  orgName,
}: {
  proposalPublicToken: string;
  petName: string;
  orgName: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);
  const [acceptedRemaining, setAcceptedRemaining] = useState<number | null>(null);
  const [mode, setMode] = useState<"none" | "accept" | "reject">("none");

  // Accept state
  const [allowCoFoster, setAllowCoFoster] = useState(false);
  const [acceptNotes, setAcceptNotes] = useState("");

  // Reject state
  const [rejectionReason, setRejectionReason] = useState<RejectionReason>("capacity");
  const [rejectNotes, setRejectNotes] = useState("");

  function accept() {
    setError(null);
    startTransition(async () => {
      const result = await acceptFosterProposalAction({
        proposalPublicToken,
        allowCoFoster,
        responseNotes: acceptNotes.trim() || null,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setAcceptedRemaining(result.remainingSlots);
      if (result.cascadeCancelledProposals.length > 0) {
        setOkMessage(
          `${result.cascadeCancelledProposals.length} propuesta(s) pendiente(s) se cancelaron por falta de capacity.`,
        );
      }
      // No navigation: the LnSuccessScreen below is local UI, and a refresh
      // here could silently drop while it renders (router.refresh() is banned
      // anyway — see lib/ui/full-page-action-nav.ts). The success screen's
      // links do full navigations to fresh SSR pages.
    });
  }

  function reject() {
    setError(null);
    startTransition(async () => {
      const result = await rejectFosterProposalAction({
        proposalPublicToken,
        rejectionReason,
        responseNotes: rejectNotes.trim() || null,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOkMessage(`Rechazaste la propuesta de ${orgName}.`);
      // Full document reload so the SSR proposal page reflects the rejected
      // state (router.refresh() is banned — see lib/ui/full-page-action-nav.ts).
      navigateAfterActionSuccess(window.location.href);
    });
  }

  if (acceptedRemaining !== null) {
    const baseDescription = `Aceptaste el tránsito de ${petName}. Te quedan ${acceptedRemaining} slot(s) disponibles para nuevas propuestas.`;
    return (
      <LnSuccessScreen
        title={`Tránsito aceptado: ${petName}`}
        description={okMessage ? `${baseDescription} ${okMessage}` : baseDescription}
        next={[
          { label: "Ver mis tránsitos", href: "/cuenta/transitos/activos" },
          { label: "Ver el perfil de la mascota", href: "/mis-mascotas", variant: "secondary" },
        ]}
      />
    );
  }

  if (okMessage) {
    return (
      <p className="text-sm rounded-[var(--radius-sm)] border border-[var(--color-ln-ok)] bg-[var(--color-ln-ok-050)] px-3 py-2 text-[var(--color-ln-ok)]">
        {okMessage}
      </p>
    );
  }

  if (mode === "accept") {
    return (
      <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-ok)] bg-[var(--color-ln-ok-050)] p-4 space-y-3">
        <h3 className="font-medium text-[var(--color-ln-ok)]">Aceptar tránsito de {petName}</h3>
        <LnCheckbox checked={allowCoFoster} onChange={(e) => setAllowCoFoster(e.target.checked)}>
          Permito que la organización asigne otro co-foster mientras yo lo cuide. Podés cambiarlo
          después.
        </LnCheckbox>
        <textarea
          value={acceptNotes}
          onChange={(e) => setAcceptNotes(e.target.value)}
          rows={2}
          placeholder="Notas para el refugio (opcional)"
          className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] text-sm outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
        />
        {error && <output className="block text-sm text-[var(--color-ln-err)]">{error}</output>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={accept}
            disabled={pending}
            className="px-4 py-2 rounded-[var(--radius-pill)] bg-[var(--color-ln-ok)] text-white font-medium hover:opacity-90 disabled:opacity-50 transition-colors"
          >
            {pending ? "Aceptando..." : "Confirmar aceptación"}
          </button>
          <button
            type="button"
            onClick={() => setMode("none")}
            disabled={pending}
            className="px-4 py-2 rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] hover:bg-[var(--color-ln-stripe)] transition-colors"
          >
            Cancelar
          </button>
        </div>
      </div>
    );
  }

  if (mode === "reject") {
    return (
      <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] p-4 space-y-3">
        <h3 className="font-medium text-[var(--color-ln-ink)]">Rechazar propuesta</h3>
        <div>
          <label
            htmlFor="reject-reason"
            className="block text-sm font-medium text-[var(--color-ln-ink)] mb-1"
          >
            Motivo
          </label>
          <select
            id="reject-reason"
            value={rejectionReason}
            onChange={(e) => setRejectionReason(e.target.value as RejectionReason)}
            className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] text-sm outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
          >
            {REJECTION_REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <textarea
          value={rejectNotes}
          onChange={(e) => setRejectNotes(e.target.value)}
          rows={2}
          placeholder="Notas (opcional)"
          className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] text-sm outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
        />
        {error && <output className="block text-sm text-[var(--color-ln-err)]">{error}</output>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={reject}
            disabled={pending}
            className="px-4 py-2 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] text-white font-medium hover:bg-[var(--color-ln-azul-700)] disabled:opacity-50 transition-colors"
          >
            {pending ? "Enviando..." : "Confirmar rechazo"}
          </button>
          <button
            type="button"
            onClick={() => setMode("none")}
            disabled={pending}
            className="px-4 py-2 rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] hover:bg-[var(--color-ln-stripe)] transition-colors"
          >
            Cancelar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <button
        type="button"
        onClick={() => setMode("accept")}
        className="px-4 py-2 rounded-[var(--radius-pill)] bg-[var(--color-ln-ok)] text-white font-medium hover:opacity-90 transition-colors"
      >
        Aceptar propuesta
      </button>
      <button
        type="button"
        onClick={() => setMode("reject")}
        className="px-4 py-2 rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] hover:bg-[var(--color-ln-stripe)] transition-colors"
      >
        Rechazar
      </button>
    </div>
  );
}
