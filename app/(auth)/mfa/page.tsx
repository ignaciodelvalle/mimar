import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { resolveUserLanding, safeReturnTo } from "@/lib/infra/role-landing";
import { createClient } from "@/lib/supabase/server";
import { type RawSearchParam, firstSearchParam } from "@/lib/utils/search-params";
import { loadMfaSession } from "@/src/modules/auth/application/mfa/mfa-session";
import { MFA_ENROL_PATH } from "@/src/modules/auth/domain/mfa-policy";

import { MfaChallengeForm } from "./MfaChallengeForm";
import { MfaShell } from "./MfaShell";

// /mfa — the second-factor challenge of an institutional account (T2-S6).
//
// Every institutional guard sends a session that signed in but has not passed
// TOTP here (requireLiveUser → mfaPending "challenge" → requireUserOrRedirect).
// So this page must never call one of those guards itself: it reads GoTrue
// through loadMfaSession, which admits exactly this session and nothing more.
//
// force-dynamic: per-request CSP nonce, and a session-dependent answer.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Verificación en dos pasos",
  robots: { index: false, follow: false },
};

export default async function MfaChallengePage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: RawSearchParam }>;
}) {
  const returnTo = safeReturnTo(firstSearchParam((await searchParams).returnTo));
  const session = await loadMfaSession(await createClient());
  if (!session) {
    redirect(
      returnTo ? `/iniciar-sesion?returnTo=${encodeURIComponent(returnTo)}` : "/iniciar-sesion",
    );
  }
  if (!session.eligible) redirect("/");
  // B9: an expired shift is signed out there, not upgraded here.
  if (session.shiftExpired) redirect("/turno-vencido");
  if (!session.verifiedFactorId) {
    redirect(
      returnTo ? `${MFA_ENROL_PATH}?returnTo=${encodeURIComponent(returnTo)}` : MFA_ENROL_PATH,
    );
  }
  if (session.requirement === "satisfied") {
    redirect(returnTo ?? (await resolveUserLanding(session.userId)));
  }

  return (
    <MfaShell
      title="Verificación en dos pasos"
      lead="Abrí tu app de autenticación y escribí el código de 6 números que muestra para miMAR."
    >
      <MfaChallengeForm returnTo={returnTo} />
      <p className="text-sm text-[var(--color-ln-ink-2)]">
        ¿Perdiste el teléfono o no tenés la app? Pedile a una persona con rol de administración de
        miMAR que restablezca tu segundo factor.
      </p>
    </MfaShell>
  );
}
