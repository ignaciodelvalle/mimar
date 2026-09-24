// Invite-acceptance layout — the first surface adopted onto the unified
// AppShell (Item 7, Phase A). This is a token-landing surface (spec D13): it
// gets the minimal trust chrome (brand + Argentina stripe + "Credencial
// registrada en miMAR"), NOT the public browse chrome.
//
// Strangler note: the three legacy chromes (LnOwnerNav / AppHeader / OpShell)
// are untouched. This single, isolated token surface — which previously had no
// shell at all — is the limited Phase A adoption that proves AppShell +
// resolveShellNav render end-to-end. The credential (/p) and libreta-share
// surfaces migrate onto the same `landing` variant in a later phase.

import Link from "next/link";
import type { ReactNode } from "react";

import { AppShell } from "@/components/layout/AppShell";
import { DemoModeBanner } from "@/components/ui/DemoModeBanner";
import { shouldShowDemoBanner } from "@/lib/domain/demo-mode";
import { getProfileCached } from "@/lib/infra/request-cache";
import { createClient } from "@/lib/supabase/server";
import { resolveShellNav } from "@/lib/ui/shell-nav";

export default async function InviteLandingLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Read session purely for the discreet "back to my app" affordance (D13).
  // This is NOT an auth gate — the invite page renders correctly logged-out.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const profile = user ? await getProfileCached(user.id) : null;

  // resolveShellNav is the single decision: a token-landing path always yields
  // the `landing` variant regardless of auth, with showReturn only when there
  // is a session to return to.
  const shell = resolveShellNav({
    pathname: `/r/invite/${token}`,
    session: profile ? { role: profile.role, displayName: profile.displayName } : null,
  });

  const returnSlot =
    shell.showReturn && shell.returnHref ? (
      <Link
        href={shell.returnHref}
        className="whitespace-nowrap text-xs font-medium text-ln-azul no-underline hover:underline"
      >
        ← Volver a mi app
      </Link>
    ) : undefined;

  return (
    <AppShell
      variant="landing"
      returnSlot={returnSlot}
      banner={<DemoModeBanner enabled={shouldShowDemoBanner(process.env.NEXT_PUBLIC_DEMO_MODE)} />}
    >
      {children}
    </AppShell>
  );
}
