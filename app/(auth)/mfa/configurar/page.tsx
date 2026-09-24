import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { resolveUserLanding, safeReturnTo } from "@/lib/infra/role-landing";
import { createClient } from "@/lib/supabase/server";
import { type RawSearchParam, firstSearchParam } from "@/lib/utils/search-params";
import { loadMfaSession } from "@/src/modules/auth/application/mfa/mfa-session";
import { MFA_CHALLENGE_PATH, MFA_ENROL_STALE_MESSAGE } from "@/src/modules/auth/domain/mfa-policy";

import { MfaShell } from "../MfaShell";
import { MfaEnrolStep } from "./MfaEnrolStep";

// /mfa/configurar — first-time second-factor setup of an institutional account
// (T2-S6). Enrolment is ENFORCED: every institutional guard sends an account
// without a verified TOTP factor here before any portal renders, and the page
// says why. It lives outside /cuenta on purpose — /cuenta is under the citizen
// layout, which bounces admin and govt roles to their portals, which would send
// them back here: the screen has to be reachable for exactly this session.
//
// Same rule as /mfa: never call an institutional guard from this page.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Configurar verificación en dos pasos",
  robots: { index: false, follow: false },
};

export default async function MfaEnrolPage({
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
  if (session.verifiedFactorId) {
    if (session.requirement === "satisfied") {
      redirect(returnTo ?? (await resolveUserLanding(session.userId)));
    }
    redirect(
      returnTo
        ? `${MFA_CHALLENGE_PATH}?returnTo=${encodeURIComponent(returnTo)}`
        : MFA_CHALLENGE_PATH,
    );
  }

  // Enrolment is trust on first use, so it is offered only to a session that
  // authenticated in the last few minutes (mfa-policy.ts). An older one is
  // told to sign in again — the shell's "Cerrar sesión" is the way.
  if (!session.enrolmentFresh) {
    return (
      <MfaShell
        title="Volvé a iniciar sesión"
        lead="Configurar la verificación en dos pasos pide una sesión recién iniciada."
      >
        <p className="text-sm text-[var(--color-ln-ink-2)]">{MFA_ENROL_STALE_MESSAGE}</p>
      </MfaShell>
    );
  }

  return (
    <MfaShell
      title="Configurá la verificación en dos pasos"
      lead="Las cuentas institucionales de miMAR piden, además de la contraseña, un código que genera una app en tu teléfono. Así, alguien que consiga tu contraseña no puede entrar sin tu teléfono."
    >
      <MfaEnrolStep returnTo={returnTo} />
    </MfaShell>
  );
}
