"use client";

// ReturnAcceptanceCard — owner UI for the devolucion page.
//
// Renders:
//   - Proposal details (actor name, notes, date)
//   - "Marcar como recibida" button → ownerAcceptReturnFormAction
//   - Reject section → ownerRejectReturnFormAction
//
// When accept returns autoCancelled=true, shows an explanation banner instead
// of success and tells the user to go back to /mis-mascotas.
//
// A confirmed return ends on LnSuccessScreen (L-13): devolución is one of the
// trámites AGENTS.md names as closing on a receipt. The accept action does not
// revalidatePath, so no RSC refresh unmounts this card under its own receipt —
// if that ever changes, keep this island mounted (see
// app/(app)/cuidado/[grantToken]/CaretakerInvitationActions.tsx for the trap).

import {
  type AcceptReturnFormState,
  type RejectReturnFormState,
  ownerAcceptReturnFormAction,
  ownerRejectReturnFormAction,
} from "@/app/actions/return-to-owner-form";
import { LnSuccessScreen } from "@/components/ui/SuccessScreen";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { AR_TIME_ZONE } from "@/lib/utils/format";
import { useActionState, useState } from "react";

const acceptInitial: AcceptReturnFormState = { error: null };
const rejectInitial: RejectReturnFormState = { error: null };

export function ReturnAcceptanceCard({
  petPublicToken,
  petName,
  actorName,
  proposalNotes,
  proposedAt,
  backUrl,
}: {
  petPublicToken: string;
  petName: string;
  actorName: string;
  proposalNotes: string | null;
  proposedAt: string;
  backUrl: string;
}) {
  const boundAccept = ownerAcceptReturnFormAction.bind(null, petPublicToken);
  const boundReject = ownerRejectReturnFormAction.bind(null, petPublicToken);

  const [acceptState, acceptFormAction, acceptPending] = useActionState(boundAccept, acceptInitial);
  // forms/react19-reset-data-loss-inventory: "reason" is an uncontrolled
  // textarea — a rejected submit wipes the rejection explanation the owner
  // just typed.
  const { boundAction: boundRejectKept, kept } = useKeptFields<RejectReturnFormState>(boundReject);
  const [rejectState, rejectFormAction, rejectPending] = useActionState(
    boundRejectKept,
    rejectInitial,
  );

  const [showRejectForm, setShowRejectForm] = useState(false);

  // Accepted successfully — the receipt.
  if (acceptState.error === null && !acceptState.autoCancelled && acceptState !== acceptInitial) {
    return (
      <LnSuccessScreen
        title="Devolución confirmada"
        description={`${petName} está de vuelta con vos. La custodia de ${actorName} quedó cerrada y le avisamos que la recibiste.`}
        next={[
          { label: `Ver la libreta de ${petName}`, href: `/mis-mascotas/${petPublicToken}` },
          { label: "Ir a mis mascotas", href: backUrl },
        ]}
      />
    );
  }

  // Auto-cancelled — show explanation banner.
  if (acceptState.autoCancelled) {
    return (
      <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-warn-050)] p-4 space-y-2">
        <p className="text-[var(--color-ln-warn)] font-medium">La propuesta ya no es válida</p>
        <p className="text-[var(--color-ln-warn)] text-sm">{acceptState.autoCancelReason}</p>
        <a href={backUrl} className="text-sm underline text-[var(--color-ln-warn)]">
          Volver a mis mascotas
        </a>
      </div>
    );
  }

  // Rejected successfully.
  if (rejectState.success) {
    return (
      <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-stripe)] p-4 space-y-2">
        <p className="text-[var(--color-ln-ink)] font-medium">
          Propuesta rechazada. {actorName} fue notificado.
        </p>
        <a href={backUrl} className="text-sm underline text-[var(--color-ln-ink-2)]">
          Volver a mis mascotas
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Proposal card */}
      <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] p-4 space-y-3">
        <div className="space-y-1">
          <p className="text-sm text-[var(--color-ln-mute)] uppercase tracking-wide">
            Propuesta de devolución
          </p>
          <p className="text-base font-semibold">
            {actorName} está listo para devolverte a {petName}
          </p>
          <p className="text-xs text-[var(--color-ln-mute)]">
            Propuesta el{" "}
            {new Date(proposedAt).toLocaleDateString("es-AR", {
              dateStyle: "long",
              timeZone: AR_TIME_ZONE,
            })}
          </p>
        </div>

        {proposalNotes && (
          <div className="rounded-[var(--radius-sm)] bg-[var(--color-ln-stripe)] p-3 text-sm text-[var(--color-ln-ink-2)] whitespace-pre-line">
            {proposalNotes}
          </div>
        )}
      </div>

      {/* Accept action */}
      {acceptState.error && (
        <p className="text-sm rounded-[var(--radius-sm)] border border-[var(--color-ln-seal)] bg-[var(--color-ln-err-050)] px-3 py-2 text-[var(--color-ln-seal)]">
          {acceptState.error}
        </p>
      )}

      <form action={acceptFormAction}>
        <button
          type="submit"
          disabled={acceptPending}
          className="w-full py-3 rounded-[var(--radius-pill)] bg-[var(--color-ln-ok)] text-white hover:opacity-90 disabled:opacity-50 font-medium transition-colors"
        >
          {acceptPending ? "Confirmando…" : "Marcar como recibida"}
        </button>
      </form>

      {/* Reject toggle */}
      {!showRejectForm && (
        <button
          type="button"
          onClick={() => setShowRejectForm(true)}
          className="text-sm text-[var(--color-ln-mute)] underline hover:text-[var(--color-ln-ink-2)]"
        >
          Rechazar propuesta
        </button>
      )}

      {showRejectForm && (
        <form
          action={rejectFormAction}
          className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] p-4"
        >
          <div className="space-y-1">
            <label
              htmlFor="reason"
              className="block text-sm font-medium text-[var(--color-ln-ink-2)]"
            >
              Motivo del rechazo
            </label>
            <textarea
              id="reason"
              name="reason"
              rows={3}
              required
              maxLength={500}
              defaultValue={kept("reason")}
              placeholder="Explicá por qué rechazás la propuesta…"
              className="w-full rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-3 py-2 text-sm resize-y outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
            />
          </div>

          {rejectState.error && (
            <p className="text-sm text-[var(--color-ln-err)]">{rejectState.error}</p>
          )}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={rejectPending}
              className="px-4 py-2 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] text-white hover:bg-[var(--color-ln-azul-700)] disabled:opacity-50 text-sm"
            >
              {rejectPending ? "Enviando…" : "Confirmar rechazo"}
            </button>
            <button
              type="button"
              onClick={() => setShowRejectForm(false)}
              className="px-4 py-2 rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] text-sm"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
