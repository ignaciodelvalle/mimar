"use client";

// The enrolment step: ask the server for a new TOTP factor (on a click, not on
// mount — a mount effect runs twice in development and would enrol twice), show
// its QR and secret, then confirm it with the first code the app shows.

import { useActionState, useEffect, useState, useTransition } from "react";

import {
  type MfaEnrolmentStart,
  type MfaStepState,
  confirmMfaEnrolmentAction,
  startMfaEnrolmentAction,
} from "@/app/actions/mfa";
import { LnButton } from "@/components/ui/Button";

import { MfaCodeField } from "../MfaCodeField";

const initialState: MfaStepState = { error: null };

export function MfaEnrolStep({ returnTo }: { returnTo: string | null }) {
  const [started, setStarted] = useState<MfaEnrolmentStart | null>(null);
  const [starting, startTransition] = useTransition();
  const [state, formAction, isPending] = useActionState(confirmMfaEnrolmentAction, initialState);

  // Full navigation: the session cookies now carry the aal2 token.
  useEffect(() => {
    if (state.next) window.location.assign(state.next);
  }, [state.next]);

  function begin() {
    startTransition(async () => {
      setStarted(await startMfaEnrolmentAction());
    });
  }

  if (!started || "error" in started) {
    return (
      <div className="space-y-4">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-[var(--color-ln-ink-2)]">
          <li>
            Instalá en tu teléfono una app de autenticación (por ejemplo Google Authenticator,
            Microsoft Authenticator o 1Password).
          </li>
          <li>Tocá el botón de abajo y escaneá el código QR con esa app.</li>
          <li>Escribí el código de 6 números que te muestra la app.</li>
        </ol>
        {started && "error" in started && (
          <p className="text-sm text-[var(--color-ln-err)]" role="alert">
            {started.error}
          </p>
        )}
        <LnButton type="button" block loading={starting} disabled={starting} onClick={begin}>
          Mostrar código QR
        </LnButton>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex justify-center">
        <img
          src={started.qrDataUrl}
          alt="Código QR para vincular tu app de autenticación con miMAR"
          width={220}
          height={220}
          className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-white"
        />
      </div>
      <div className="space-y-1 text-sm text-[var(--color-ln-ink-2)]">
        <p>¿No podés escanear? Cargá esta clave a mano en la app:</p>
        <code className="block break-all rounded-[var(--radius-sm)] bg-[var(--color-ln-stripe)] p-2 font-ln-mono text-[var(--color-ln-ink)]">
          {started.secret}
        </code>
      </div>
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="factorId" value={started.factorId} />
        {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
        <MfaCodeField />
        {state.error && (
          <p className="text-sm text-[var(--color-ln-err)]" role="alert">
            {state.error}
          </p>
        )}
        <LnButton
          type="submit"
          block
          loading={isPending || Boolean(state.next)}
          disabled={isPending}
        >
          {state.next ? "Entrando..." : "Confirmar y entrar"}
        </LnButton>
      </form>
    </div>
  );
}
