// Libreta-share landing layout — a token-landing surface (spec D13), migrated
// onto the unified AppShell variant=landing (Item 7, Phase C). A shared libreta
// link is scanned/opened by a vet or a trusted third party: it gets the minimal
// trust chrome (brand + Argentina stripe + "Credencial registrada en miMAR"),
// NOT the public browse chrome.
//
// resolveShellNav is the single decision: a token-landing path always yields
// the `landing` variant regardless of auth, with a discreet "back to my app"
// return only when there is a session to return to (a logged-in owner scanning
// their own share link still gets a quiet way home).
//
// The page below drops its own full-screen `<main id="main-content">` — this
// landing shell now owns `#main-content` + min-height (D11). No page content,
// data fetching, or token validation changes.

import Link from "next/link";
import type { ReactNode } from "react";

import { AppShell } from "@/components/layout/AppShell";
import { DemoModeBanner } from "@/components/ui/DemoModeBanner";
import { shouldShowDemoBanner } from "@/lib/domain/demo-mode";
import { getProfileCached } from "@/lib/infra/request-cache";
import { createClient } from "@/lib/supabase/server";
import { resolveShellNav } from "@/lib/ui/shell-nav";

export default async function LibretaShareLandingLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ shareToken: string }>;
}) {
  const { shareToken } = await params;

  // Read session purely for the discreet "back to my app" affordance (D13).
  // This is NOT an auth gate — the share page renders correctly logged-out.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const profile = user ? await getProfileCached(user.id) : null;

  const shell = resolveShellNav({
    pathname: `/libreta/compartir/${shareToken}`,
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
