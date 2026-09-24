import Link from "next/link";
import { redirect } from "next/navigation";

import { authMethodReferences, verifiedSessionClaims } from "@/lib/infra/verified-token-claims";
import { createClient } from "@/lib/supabase/server";
import { FIRST_ACCESS_PATH, isPasswordSetupPending } from "@/src/modules/auth/domain/first-access";
import { hasFreshRecoveryProof } from "@/src/modules/auth/domain/recovery-proof";

import { UpdatePasswordForm } from "./UpdatePasswordForm";

// The recovery session is established BEFORE this page: by the six-digit code the
// mail carries, redeemed at /recuperar in the BROWSER (ResetCodeStep.tsx → verifyOtp
// on the browser client, which writes the auth cookies this page then reads), or by
// the legacy link through /auth/callback (exchangeCodeForSession). Either way the
// user lands here authenticated.
//
// Security: we verify that a valid session exists (getUser) before rendering the form.
// Without this check, anyone could GET this URL and see an update-password form that
// would then fail server-side — the page-level check gives the user a clear error
// instead of a confusing form experience.
export default async function ActualizarPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // No valid session — redirect to the request page with an informative flag.
    redirect("/recuperar?expired=1");
  }

  // An account that still owes its FIRST password pays it at /primer-acceso,
  // where the arming stamp decides which session may (first-access.ts). A
  // first-access link session would otherwise pass the recovery proof below.
  if (isPasswordSetupPending(user)) redirect(FIRST_ACCESS_PATH);

  // A04-1: an ORDINARY session is not a recovery session. The action refuses it
  // (update-password.ts); showing it the form first would be a form that can
  // only fail. Same proof, same destination as an expired recovery session.
  if (!hasFreshRecoveryProof(authMethodReferences(await verifiedSessionClaims(supabase)))) {
    redirect("/recuperar?expired=1");
  }

  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center p-6 bg-[var(--color-ln-paper)]"
    >
      <div className="w-full max-w-sm mb-2">
        <Link
          href="/iniciar-sesion"
          className="inline-flex items-center gap-1 text-sm text-[var(--color-ln-ink-2)] no-underline hover:text-[var(--color-ln-azul)]"
        >
          ← Volver al inicio de sesión
        </Link>
      </div>
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-2">
          <h1 className="font-ln-serif text-3xl font-semibold tracking-[-0.02em] text-[var(--color-ln-ink)]">
            Crear nueva contraseña
          </h1>
          <p className="text-sm text-[var(--color-ln-ink-2)]">
            Elegí una contraseña segura para tu cuenta.
          </p>
        </div>
        <UpdatePasswordForm />
      </div>
    </main>
  );
}
