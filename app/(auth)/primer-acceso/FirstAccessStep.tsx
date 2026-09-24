"use client";

// The client half of /primer-acceso (pilot T1-P3). Three phases:
//
//   1. OPENING — the invite link lands with the session in the URL fragment
//      (`#access_token=…&refresh_token=…`, GoTrue's implicit redirect). The
//      browser client is a PKCE client and deliberately refuses to pick an
//      implicit session up on its own, so this step hands the two tokens to
//      `setSession` explicitly, which writes the auth cookies the server
//      action then reads. The fragment is wiped from the address bar at once,
//      so the tokens do not stay in history or get copied along with the URL.
//      A fragment carrying an error (used or expired link) goes straight to
//      the "pedí un link nuevo" phase. No fragment at all (a reload after
//      step 1) falls back to whatever session the cookies already hold.
//   2. FORM — the same two-box password pair as /recuperar/actualizar, with
//      the same rules (validateNewPassword, enforced again on the server).
//   3. DONE — a SuccessScreen whose button goes to the account's portal.

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";

import { type SetInitialPasswordState, setInitialPasswordAction } from "@/app/actions/first-access";
import { LnButton } from "@/components/ui/Button";
import { LnField, LnPasswordInput } from "@/components/ui/Field";
import { LnSuccessScreen } from "@/components/ui/SuccessScreen";
import { createClient } from "@/lib/supabase/client";
import { CONTACT_EMAILS, mailtoHref } from "@/lib/ui/contact";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { MIN_PASSWORD_LENGTH } from "@/src/modules/auth/domain/new-password-rules";

type Phase = "opening" | "form" | "invalid";

const initialState: SetInitialPasswordState = { error: null };

/** Reads the session GoTrue put in the fragment, if any, and clears it. */
function takeFragment(): URLSearchParams | null {
  const raw = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
  if (!raw) return null;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  return new URLSearchParams(raw);
}

export function FirstAccessStep() {
  const [phase, setPhase] = useState<Phase>("opening");
  const { boundAction, kept } = useKeptFields(setInitialPasswordAction);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);

  useEffect(() => {
    let cancelled = false;
    const fragment = takeFragment();
    const supabase = createClient();

    async function open(): Promise<Phase> {
      if (fragment?.get("error") || fragment?.get("error_code")) return "invalid";
      const accessToken = fragment?.get("access_token");
      const refreshToken = fragment?.get("refresh_token");
      if (accessToken && refreshToken) {
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        return error ? "invalid" : "form";
      }
      const { data } = await supabase.auth.getUser();
      return data.user ? "form" : "invalid";
    }

    open()
      .catch(() => "invalid" as const)
      .then((next) => {
        if (!cancelled) setPhase(next);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.ok) {
    return (
      <LnSuccessScreen
        title="Tu contraseña quedó guardada"
        description="Desde ahora entrás con tu email y esta contraseña."
        next={[{ label: "Ir a mi panel", href: state.landing ?? "/", variant: "primary" }]}
      />
    );
  }

  if (phase === "opening") {
    return (
      <output className="block text-center text-sm text-[var(--color-ln-ink-2)]">
        Abriendo tu acceso…
      </output>
    );
  }

  if (phase === "invalid") {
    return (
      <div className="space-y-4 text-center">
        <h1 className="font-ln-serif text-3xl font-semibold tracking-[-0.02em] text-[var(--color-ln-ink)]">
          El link no sirve más
        </h1>
        <p className="text-sm text-[var(--color-ln-ink-2)]">
          Los links de acceso se usan una sola vez y vencen. Pedile a quien te creó la cuenta que te
          envíe uno nuevo, o escribinos a{" "}
          <a
            href={mailtoHref(CONTACT_EMAILS.general, { subject: "miMAR — link de acceso" })}
            className="text-[var(--color-ln-azul)] underline underline-offset-4"
          >
            {CONTACT_EMAILS.general}
          </a>
          .
        </p>
        <p className="text-sm text-[var(--color-ln-ink-2)]">
          Si ya elegiste tu contraseña,{" "}
          <Link
            href="/iniciar-sesion"
            className="text-[var(--color-ln-azul)] underline underline-offset-4"
          >
            iniciá sesión
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="text-center space-y-2">
        <h1 className="font-ln-serif text-3xl font-semibold tracking-[-0.02em] text-[var(--color-ln-ink)]">
          Establecé tu contraseña
        </h1>
        <p className="text-sm text-[var(--color-ln-ink-2)]">
          Es tu primer acceso. Elegí la contraseña con la que vas a entrar de ahora en más.
        </p>
      </div>
      <form action={formAction} className="space-y-4">
        <LnField label="Contraseña" required hint={`Mínimo ${MIN_PASSWORD_LENGTH} caracteres.`}>
          {({ id, describedBy, invalid }) => (
            <LnPasswordInput
              id={id}
              name="password"
              defaultValue={kept("password")}
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              required
              aria-describedby={describedBy}
              invalid={invalid}
            />
          )}
        </LnField>
        <LnField label="Repetir contraseña" required>
          {({ id, describedBy, invalid }) => (
            <LnPasswordInput
              id={id}
              name="confirmPassword"
              defaultValue={kept("confirmPassword")}
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              required
              aria-describedby={describedBy}
              invalid={invalid}
            />
          )}
        </LnField>

        {state.error && (
          <p className="text-sm text-[var(--color-ln-err)]" role="alert">
            {state.error}
          </p>
        )}

        <LnButton type="submit" block size="lg" loading={isPending}>
          Guardar contraseña y entrar
        </LnButton>
      </form>
    </>
  );
}
