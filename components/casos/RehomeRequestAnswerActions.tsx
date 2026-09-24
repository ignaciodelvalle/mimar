"use client";

// The sponsoring org's answer to a titular's rehome_request, on the case
// detail (rehome-by-titular WU5, task 5.7; spec REQ-4, REQ-5).
//
// TWO ANSWERS, TWO CONFIRMATIONS, and the accept one is load-bearing. An
// accept grants the org a registry custody row beside the titular's owner row,
// publishes the listing and records the titular's consent on the spine — and
// REQ-15 gives the ORG no way back: only the titular ends a sponsorship. So
// the confirmation says, before the click, what the org is taking on and what
// it is NOT: the animal keeps living with its family; the org does not have
// it in its possession (REQ-11's sentence, at the moment it is decided).
//
// The decline is cheap for everyone — the titular can ask again, the same
// org or another — but it still confirms: a closed request is a closed case,
// and the timeline will carry "rechazada por la organización" forever.
//
// Post-success is a full document navigation (lib/ui/full-page-action-nav.ts):
// the detail re-reads with the answer on its timeline and these controls gone.

import { useState, useTransition } from "react";

import { LnButton } from "@/components/ui/Button";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { respondToRehomeRequestAction } from "@/src/modules/rehome/actions";

type Props = {
  /** The org resolved from the case's receiver_organization_id — the URL org the action pins. */
  orgToken: string;
  casePublicCode: string;
  petName: string;
  orgDisplayName: string;
};

type Mode = "none" | "accept" | "decline";

export function RehomeRequestAnswerActions({
  orgToken,
  casePublicCode,
  petName,
  orgDisplayName,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<Mode>("none");
  const [error, setError] = useState<string | null>(null);

  function run(decision: "accept" | "decline") {
    setError(null);
    startTransition(async () => {
      const result = await respondToRehomeRequestAction({ orgToken, casePublicCode, decision });
      if ("error" in result) {
        setError(result.error);
        setMode("none");
        return;
      }
      navigateAfterActionSuccess(result.redirectTo);
    });
  }

  return (
    <section
      aria-label="Respuesta a la solicitud de nuevo hogar"
      className="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-4"
    >
      <h2 className="m-0 font-ln-serif text-lg font-semibold text-[var(--color-ln-ink)]">
        Responder la solicitud
      </h2>
      <p className="m-0 text-md leading-snug text-[var(--color-ln-ink-2)]">
        El titular de {petName} le pide a {orgDisplayName} que acompañe su adopción: publicarlo en
        la búsqueda de hogar y evaluar a quienes se postulen.
      </p>

      {error && (
        <p role="alert" className="m-0 text-sm text-[var(--color-ln-err)]">
          {error}
        </p>
      )}

      {mode === "none" && (
        <div className="flex flex-wrap gap-2">
          <LnButton variant="primary" onClick={() => setMode("accept")}>
            Aceptar el acompañamiento
          </LnButton>
          <LnButton variant="ghost" onClick={() => setMode("decline")}>
            Rechazar la solicitud
          </LnButton>
        </div>
      )}

      {mode === "accept" && (
        <div className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-azul)] bg-[var(--color-ln-celeste-050)] p-4">
          <p className="m-0 text-md leading-snug text-[var(--color-ln-ink-2)]">
            {orgDisplayName} pasa a tener la custodia registral de {petName} para publicarlo y
            evaluar postulantes. {petName} sigue viviendo con su familia: la organización no lo
            tiene en su poder. Solo el titular puede dar de baja el acompañamiento.
          </p>
          <div className="flex flex-wrap gap-2">
            <LnButton variant="primary" onClick={() => run("accept")} disabled={pending}>
              {pending ? "Procesando…" : "Confirmar el acompañamiento"}
            </LnButton>
            <LnButton variant="ghost" onClick={() => setMode("none")} disabled={pending}>
              Volver
            </LnButton>
          </div>
        </div>
      )}

      {mode === "decline" && (
        <div className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-seal)] bg-[var(--color-ln-err-050)] p-4">
          <p className="m-0 text-md leading-snug text-[var(--color-ln-ink-2)]">
            La solicitud se cierra como rechazada y el titular lo va a ver así. No se crea ninguna
            publicación; el titular puede pedírselo a otra organización.
          </p>
          <div className="flex flex-wrap gap-2">
            <LnButton variant="seal" onClick={() => run("decline")} disabled={pending}>
              {pending ? "Procesando…" : "Confirmar el rechazo"}
            </LnButton>
            <LnButton variant="ghost" onClick={() => setMode("none")} disabled={pending}>
              Volver
            </LnButton>
          </div>
        </div>
      )}
    </section>
  );
}
