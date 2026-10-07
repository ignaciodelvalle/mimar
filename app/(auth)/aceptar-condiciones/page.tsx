import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { logoutAction } from "@/app/actions/auth";
import { LnButton } from "@/components/ui/Button";
import { LEGAL_ACCEPTANCE_PATH, isLegalAcceptancePending } from "@/lib/domain/legal-acceptance";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { getProfileCached } from "@/lib/infra/request-cache";
import { safeReturnTo } from "@/lib/infra/role-landing";
import { legalChangesSince } from "@/lib/reference/legal-version";
import { LegalAcceptanceForm } from "./LegalAcceptanceForm";

// /aceptar-condiciones — an EXISTING personal account accepts the current legal
// version before it keeps using the product (2026-10-07).
//
// WHY (legal review 2026-10-02, rows P10, P11 and D5; PO decision D2 = b, a
// conservative interim): a substantive change of the Terms needs a new
// acceptance, not an email (Disp. 377/2026 inc. b), and accounts created before
// this version consented to the international transfer inside the Terms box,
// not in a box of its own (Dec. 1558/2001 art. 5 inc. 1). Who is sent here and
// why exactly those: lib/domain/legal-acceptance.ts. Who sends them: the (app)
// layout on every request and the login use-case at sign-in. The app has its
// own screen for the same act (apps/mobile/app/aceptar-condiciones.tsx).
//
// A GENERAL CIRCUIT, NOT A ONE-OFF (legal report 2026-10, §3.1 row 5: F-9
// closed — a substantive change needs a POSITIVE act of acceptance; silence is
// not acceptance, CCyC art. 979). Every bump of LEGAL_VERSION sends every
// personal account on an older version here; the page lists what changed since
// the version THEY accepted (LEGAL_VERSION_CHANGES) and asks again.
//
// OUTSIDE the (app) group on purpose: the layout that sends people here must
// not wrap the page that releases them, or the two would loop.
//
// THE WAY OUT IS NOT ONLY "ACCEPT". Somebody who does not agree can sign out,
// or download their data and delete the account: /cuenta/privacidad is the one
// owner-portal page the layout lets through while an acceptance is owed.
//
// force-dynamic: the session decides what renders, and the CSP nonce is minted
// per request (same reason as /primer-acceso).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Actualizamos los términos",
  robots: { index: false, follow: false },
};

export default async function AceptarCondicionesPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const sp = await searchParams;
  const returnTo = safeReturnTo(sp.returnTo);
  const { user } = await requireUserOrRedirect(LEGAL_ACCEPTANCE_PATH);
  const profile = await getProfileCached(user.id);

  // Nothing owed (already accepted, institutional, or a signup still in
  // progress): this page has nothing to ask, so it gets out of the way.
  if (!profile || !isLegalAcceptancePending(profile)) {
    redirect(returnTo ?? "/inicio");
  }

  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center p-6 bg-[var(--color-ln-paper)]"
    >
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-3">
          <h1 className="font-ln-serif text-title font-semibold tracking-[-0.01em] text-[var(--color-ln-ink)]">
            Actualizamos los términos y la política de privacidad
          </h1>
          <p className="text-sm text-[var(--color-ln-ink-2)]">
            Para seguir usando tu cuenta necesitamos que los aceptes de nuevo. Desde la última vez
            que los aceptaste cambió esto:
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--color-ln-ink-2)]">
            {legalChangesSince(profile.tosVersion).map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        </div>

        <LegalAcceptanceForm returnTo={returnTo} />

        <div className="space-y-2 text-center text-sm text-[var(--color-ln-ink-2)]">
          <p>
            Si no estás de acuerdo, podés{" "}
            <Link
              href="/cuenta/privacidad"
              className="font-medium text-[var(--color-ln-azul)] underline underline-offset-2"
            >
              descargar tus datos o eliminar tu cuenta
            </Link>
            , o cerrar sesión.
          </p>
          <form action={logoutAction}>
            <LnButton type="submit" variant="ghost" size="sm">
              Cerrar sesión
            </LnButton>
          </form>
        </div>
      </div>
    </main>
  );
}
