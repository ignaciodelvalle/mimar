import { and, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { logoutAction } from "@/app/actions/auth";
import { db, organizationMemberships } from "@/db";
import { getIntentCopy } from "@/lib/domain/auth-intent-copy";
import { getProfileCached } from "@/lib/infra/request-cache";
import {
  isDeactivatedInstitutional,
  isErasedAccount,
  pathForRole,
  resolveVetLanding,
  safeReturnTo,
} from "@/lib/infra/role-landing";
import { createClient } from "@/lib/supabase/server";

import { LoginForm } from "./LoginForm";

// Login mirrors signup's `intent=apply` + `returnTo` plumbing so a visitor
// who clicks "¿Ya tenés cuenta?" on the signup-from-adoption flow keeps
// the apply intent through the entire round-trip.
//
// Item 24.1: when an `intent` param is present, the page swaps in contextual
// copy (headline + subcopy) so the gate is explained, not just enforced.

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ intent?: string; returnTo?: string; motivo?: string }>;
}) {
  const sp = await searchParams;
  // Preserve the raw intent value so the copy map can match it (not just "apply").
  const intent = sp.intent ?? null;
  const returnTo = safeReturnTo(sp.returnTo);
  // B9: /turno-vencido sends an operator here AFTER signing them out, so this
  // notice explains a page they did not ask for. It is informational, not an
  // error — the shift ending is the system working — and it needs no logout
  // surface of its own, unlike the two account-state notices below: by the time
  // it renders there is no session left to close.
  const shiftEnded = sp.motivo === "turno";
  // B11: the user pressed "cerrar sesión en todos los dispositivos" and this
  // browser was one of them. Confirming it here is the whole point — the action
  // logged them out of the page they were standing on, so without a word it
  // looks like something broke rather than like the button working.
  const sessionsRevoked = sp.motivo === "sesiones-cerradas";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Deactivated institutional session (task #39): do NOT redirect by role —
  // the portal guard bounces it back and the redirects loop until the browser
  // gives up (ERR_TOO_MANY_REDIRECTS), leaving the account with no logout
  // surface at all. Render the login page with a notice + "Cerrar sesión".
  const profile = user ? await getProfileCached(user.id) : null;
  const deactivatedSession = isDeactivatedInstitutional(profile);
  // Erased account (Ley 25.326 art. 16): like a deactivated session, never
  // redirect it into the app — requireUserOrRedirect bounces erased profiles
  // straight back here, so an auto-redirect by role would loop forever. Render
  // the notice + a guaranteed logout surface instead.
  const erasedSession = isErasedAccount(profile);

  if (user && !deactivatedSession && !erasedSession) {
    if (returnTo) redirect(returnTo);

    const role = profile?.role ?? "owner";
    if (role === "vet") {
      redirect(await resolveVetLanding(user.id));
    }
    let hasOrgAdminMembership = false;
    if (role === "owner") {
      const [membership] = await db
        .select({ id: organizationMemberships.id })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.userId, user.id),
            eq(organizationMemberships.role, "admin"),
            isNull(organizationMemberships.leftAt),
          ),
        )
        .limit(1);
      hasOrgAdminMembership = !!membership;
    }
    redirect(pathForRole(role, { hasOrgAdminMembership }));
  }

  const intentCopy = getIntentCopy(intent);

  // Build the signup link — preserve intent + returnTo so the round-trip
  // doesn't lose context if the visitor switches from login to signup.
  //
  // `returnTo` USED TO SURVIVE ONLY ALONGSIDE AN INTENT here too (the mirror of
  // the bug fixed on /registro, native QA batch 2 D6): the old expression fell
  // through to a bare "/registro" whenever there was a destination and no
  // intent, so the round trip this comment promises was only half true.
  const signupParams = new URLSearchParams();
  if (intent) signupParams.set("intent", intent);
  if (returnTo) signupParams.set("returnTo", returnTo);
  const signupQuery = signupParams.toString();
  const signupHref = signupQuery === "" ? "/registro" : `/registro?${signupQuery}`;

  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center p-6 bg-[var(--color-ln-paper)]"
    >
      {/* Back link — lean, keeps the centered layout intact */}
      <div className="w-full max-w-sm mb-2">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-[var(--color-ln-ink-2)] no-underline hover:text-[var(--color-ln-azul)]"
        >
          ← Volver al inicio
        </Link>
      </div>
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-2">
          {/* 24.1 Intent-aware heading: contextual label when an intent is present. */}
          <h1
            id="auth-heading"
            className="font-ln-serif text-3xl font-semibold tracking-[-0.02em] text-[var(--color-ln-ink)]"
          >
            {intentCopy ? intentCopy.headline : "Iniciar sesión"}
          </h1>
          {/* 24.1 Subcopy: tied to the heading via aria-labelledby on the form below. */}
          <p className="text-sm text-[var(--color-ln-ink-2)]" aria-describedby="auth-heading">
            {intentCopy ? intentCopy.subcopy : "Hola de nuevo"}
          </p>
        </div>
        {/* Erased account (Ley 25.326 art. 16): the account was deleted at the
            subject's request. Clear notice + a guaranteed logout surface so the
            stale session can be dropped. Rendered before the deactivated notice
            because erasure is the stronger, terminal state. */}
        {erasedSession && (
          <div
            role="alert"
            className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-err-100)] bg-[var(--color-ln-err-bg)] px-4 py-3 text-sm text-[var(--color-ln-ink)]"
          >
            <p className="font-medium text-[var(--color-ln-err)]">Esta cuenta fue eliminada.</p>
            <p>
              Eliminaste tu cuenta y tus datos personales a tu pedido. No podés volver a acceder con
              ella. Si querés usar miMAR de nuevo, creá una cuenta nueva.
            </p>
            <form action={logoutAction}>
              <button
                type="submit"
                className="cursor-pointer border-0 bg-transparent p-0 text-sm font-medium text-[var(--color-ln-azul)] underline underline-offset-2 hover:text-[var(--color-ln-azul-700)]"
              >
                Cerrar sesión
              </button>
            </form>
          </div>
        )}
        {/* Deactivated institutional account: clear notice + a guaranteed
            logout surface (server-action form works even without JS). */}
        {deactivatedSession && (
          <div
            role="alert"
            className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-err-100)] bg-[var(--color-ln-err-bg)] px-4 py-3 text-sm text-[var(--color-ln-ink)]"
          >
            <p className="font-medium text-[var(--color-ln-err)]">
              Tu cuenta institucional está desactivada.
            </p>
            <p>
              No podés acceder al portal. Si creés que se trata de un error, contactá al equipo de
              miMAR.
            </p>
            <form action={logoutAction}>
              <button
                type="submit"
                className="cursor-pointer border-0 bg-transparent p-0 text-sm font-medium text-[var(--color-ln-azul)] underline underline-offset-2 hover:text-[var(--color-ln-azul-700)]"
              >
                Cerrar sesión
              </button>
            </form>
          </div>
        )}
        {/* Shift ended (B9). Neutral chrome on purpose: an operator whose 8
            hours ran out did nothing wrong, and dressing a routine boundary in
            the error palette teaches people to ignore the error palette. */}
        {shiftEnded && (
          // <output> rather than a div with an explicit status role — the repo's
          // convention (see SolicitarAccesoForm), and what biome's
          // useSemanticElements requires. `block` because <output> is inline.
          <output className="block space-y-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-paper-2)] px-4 py-3 text-sm text-[var(--color-ln-ink)]">
            <p className="font-medium">Tu turno de trabajo terminó.</p>
            <p>
              Por seguridad cerramos la sesión en todos tus dispositivos después de 8 horas. Volvé a
              iniciar sesión para seguir trabajando.
            </p>
          </output>
        )}
        {sessionsRevoked && (
          <output className="block space-y-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-paper-2)] px-4 py-3 text-sm text-[var(--color-ln-ink)]">
            <p className="font-medium">Cerramos todas tus sesiones.</p>
            <p>
              Ya no hay ninguna sesión abierta en tus otros dispositivos. Iniciá sesión de nuevo
              para volver a entrar.
            </p>
          </output>
        )}
        <LoginForm returnTo={returnTo} />
        <p className="text-center text-sm text-[var(--color-ln-ink-2)]">
          ¿No tenés cuenta?{" "}
          <Link
            href={signupHref}
            className="font-medium text-[var(--color-ln-ink)] underline underline-offset-4"
          >
            Crear cuenta
          </Link>
        </p>
      </div>
    </main>
  );
}
