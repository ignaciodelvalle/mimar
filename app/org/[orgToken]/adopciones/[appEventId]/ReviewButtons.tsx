"use client";

// The refugio's decision on an adoption application ends on a receipt (L-13),
// not on a push back to the queue.
//
// THIS ISLAND STAYS MOUNTED ACROSS THE DECISION, ON PURPOSE. approve/reject call
// revalidatePath on THIS route, so the action's response carries the page
// re-rendered with the decision on file. The page used to swap this component
// out for <DecisionSummary> in that same render, which would unmount any local
// success flag before it could paint (the trap documented in
// app/(app)/cuidado/[grantToken]/CaretakerInvitationActions.tsx). So the page
// hands the server-rendered resolved view in as `resolvedView` and always
// renders this component in the same slot; a decision made HERE shows its
// receipt, a decision already on file shows the server's summary.

import type { ReactNode } from "react";
import { useState, useTransition } from "react";

import { LnSuccessScreen } from "@/components/ui/SuccessScreen";
import { OpButton, OpTextarea } from "@/components/ui/dashboard";
import { notifySaved } from "@/lib/ui/action-feedback";
import {
  approveAdoptionApplicationAction,
  rejectAdoptionApplicationAction,
  requestInfoAdoptionApplicationAction,
} from "@/src/modules/adoption/actions";

export function ReviewButtons({
  orgToken,
  applicationEventId,
  applicantName,
  petName,
  finalizeHref,
  resolvedView,
}: {
  orgToken: string;
  applicationEventId: string;
  applicantName: string;
  petName: string;
  /** Where the refugio finalizes the adoption once an application is approved. */
  finalizeHref: string;
  /**
   * Server-rendered view for an application that can no longer be decided
   * (already decided, or the pet was adopted by someone else). Null while the
   * application is open. Rendered here, not by the page, so this island never
   * unmounts under its own receipt — see the header.
   */
  resolvedView: ReactNode | null;
}) {
  const [decided, setDecided] = useState<"approve" | "reject" | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [mode, setMode] = useState<"approve" | "reject" | "request_info" | null>(null);
  const [sent, setSent] = useState(false);

  function reset() {
    setMode(null);
    setError(null);
    setNotes("");
    setSent(false);
  }

  function confirm() {
    if (!mode) return;
    setError(null);

    if (mode === "request_info") {
      startTransition(async () => {
        const result = await requestInfoAdoptionApplicationAction(orgToken, {
          applicationEventId,
          message: notes,
        });
        if ("error" in result) {
          setError(result.error);
          return;
        }
        setSent(true);
        // request_info never navigates (unlike approve/reject, which push to
        // the queue) — the toast is the confirmation (mutation-feedback
        // convention, lib/ui/action-feedback.ts).
        notifySaved("Mensaje enviado");
      });
      return;
    }

    const action =
      mode === "approve" ? approveAdoptionApplicationAction : rejectAdoptionApplicationAction;
    startTransition(async () => {
      const result = await action(orgToken, {
        applicationEventId,
        notes: notes.trim() || null,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setDecided(mode);
    });
  }

  const queueHref = `/org/${orgToken}/adopciones`;

  if (decided === "approve") {
    return (
      <LnSuccessScreen
        title="Postulación aprobada"
        description={`${applicantName} recibe una notificación y un mail. La adopción de ${petName} se concreta cuando la finalices en su ficha.`}
        next={[
          { label: "Finalizar la adopción", href: finalizeHref },
          { label: "Volver a las postulaciones", href: queueHref },
        ]}
      />
    );
  }

  if (decided === "reject") {
    return (
      <LnSuccessScreen
        title="Postulación cerrada"
        description={`No avanzaste con la postulación de ${applicantName}. Le llega una notificación con la decisión.`}
        next={[{ label: "Volver a las postulaciones", href: queueHref }]}
      />
    );
  }

  if (resolvedView) return <>{resolvedView}</>;

  if (sent) {
    return (
      <div className="space-y-3 rounded-[var(--radius-md)] border border-ln-op-ok-bd bg-ln-op-ok-bg p-4">
        <p className="text-md font-medium text-ln-op-ok">Mensaje enviado a {applicantName}.</p>
        <OpButton type="button" variant="ghost" onClick={reset}>
          Volver a las acciones
        </OpButton>
      </div>
    );
  }

  if (mode === null) {
    return (
      <div className="flex flex-wrap gap-2">
        <OpButton type="button" variant="ok" onClick={() => setMode("approve")}>
          Aprobar postulación
        </OpButton>
        <OpButton type="button" variant="primary" onClick={() => setMode("request_info")}>
          Solicitar más información
        </OpButton>
        <OpButton type="button" variant="danger" onClick={() => setMode("reject")}>
          No avanzar
        </OpButton>
      </div>
    );
  }

  const labelMap = {
    approve: `Aprobar la postulación de ${applicantName}.`,
    reject: `No avanzar con la postulación de ${applicantName}.`,
    request_info: `Pedirle más información a ${applicantName}.`,
  } as const;

  const hintMap = {
    approve:
      "El postulante recibe una notificación y un mail. La adopción se concreta cuando finalices en su ficha.",
    reject: "El postulante recibe una notificación. Las notas son opcionales.",
    request_info:
      "El postulante recibe una notificación con tu mensaje. La postulación queda pendiente.",
  } as const;

  const placeholderMap = {
    approve: "Notas internas (opcional)",
    reject: "Motivo (opcional)",
    request_info: "Escribí qué información necesitás...",
  } as const;

  // Verb of the act, never "Confirmar" (D.3, 2026-07-30). `reject` deliberately
  // repeats the trigger's wording ("No avanzar") instead of the harsher
  // "Rechazar postulación": this screen already chose the softer verb for the
  // act, and a commit button that renames the act mid-flow is a second act.
  const confirmLabelMap = {
    approve: "Aprobar postulación",
    reject: "No avanzar",
    request_info: "Enviar mensaje",
  } as const;

  const confirmVariantMap = {
    approve: "ok",
    reject: "danger",
    request_info: "primary",
  } as const;

  return (
    <div className="space-y-3 rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4">
      <p className="text-md font-medium text-ln-op-ink">{labelMap[mode]}</p>
      <p className="text-sm text-ln-op-mute">{hintMap[mode]}</p>
      <OpTextarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={3}
        placeholder={placeholderMap[mode]}
      />
      {error && <output className="block text-sm text-ln-op-danger">{error}</output>}
      <div className="flex gap-2">
        <OpButton
          type="button"
          variant={confirmVariantMap[mode]}
          onClick={confirm}
          disabled={pending}
        >
          {pending ? "Procesando..." : confirmLabelMap[mode]}
        </OpButton>
        <OpButton type="button" variant="ghost" onClick={reset} disabled={pending}>
          Cancelar
        </OpButton>
      </div>
    </div>
  );
}
