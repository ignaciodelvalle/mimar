import { loadWithTimeout } from "@/lib/analytics/analytics-load";
import { headers } from "next/headers";

import { AppCitizenMasthead } from "@/components/layout/AppCitizenMasthead";
import { AppShell } from "@/components/layout/AppShell";
import { CitizenTabBar } from "@/components/layout/CitizenTabBar";
import { PUBLIC_NAV } from "@/components/layout/nav-presets";
import { DemoModeBanner } from "@/components/ui/DemoModeBanner";
import { shouldShowDemoBanner } from "@/lib/domain/demo-mode";
import {
  getOrgMembershipsCached,
  getOwnedPetsCountCached,
  getProfileCached,
  getUnreadCountCached,
} from "@/lib/infra/request-cache";
import { createClient } from "@/lib/supabase/server";
import { type ShellRole, isTokenLandingPath, resolveShellNav } from "@/lib/ui/shell-nav";

/**
 * Layout for public and institutional pages — migrated to the unified AppShell
 * (Item 7, Phase C). The nav is chosen by auth state, NOT by route-group (D3):
 *
 *   - Anonymous visitor → citizen chrome + PUBLIC_NAV.
 *   - Logged-in owner   → citizen chrome + their ROLE nav (OWNER_NAV) plus a
 *                         guaranteed ≤1-click return to the role home (D4).
 *
 * This is THE stranded-user fix: a logged-in owner who lands on a public
 * surface (/adoptar, /refugios, /denuncias) keeps their role nav and a clear
 * way back, instead of being dumped onto PUBLIC_NAV with only a truncated name
 * chip as the escape. resolveShellNav already encodes this; here we wire it at
 * the layout boundary (a server component → resolve session → pass to AppShell).
 *
 * Token-landing surfaces under this group (/p/[publicToken] and its
 * sub-actions, /libreta/compartir/[shareToken]) are NOT browse pages — they
 * render their own full-screen credential `<main id="main-content">`. For
 * those paths this layout renders a transparent passthrough so it does not
 * add a second `#main-content`.
 *
 * Auth-aware but NEVER an auth gate: this layout renders for anonymous visitors
 * too and must not redirect.
 */

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const pathname = (await headers()).get("x-pathname") ?? "/";

  // Token-landing surfaces own their own #main-content — pass through untouched
  // so we never duplicate the landmark.
  if (isTokenLandingPath(pathname)) {
    return <>{children}</>;
  }

  // Resolve session best-effort. createClient reads auth cookies; if absent,
  // getUser() returns null without throwing. Never redirect from here — this
  // layout is public and must render for anonymous visitors too.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const profile = user ? await getProfileCached(user.id) : null;

  let unreadCount = 0;
  let orgMemberships: { token: string; name: string }[] = [];
  // The bottom tabs follow the logged-in citizen here too, so this layout needs
  // the same D.8 signal as app/(app)/layout.tsx — otherwise the centre slot
  // would fall back to the inert /inicio?sheet=anotar for a pets-less owner on
  // /adoptar, /refugios, /denuncias. Anonymous visitors pay nothing: the whole
  // block is inside the `user` guard, and the tabs don't render for them.
  let ownedPetsCount = 0;
  if (user) {
    // BOUNDED (2026-08-09) — same three counters as the owner shell, same
    // reasoning: a layout hang takes every public route with it for a signed-in
    // visitor, and there is no boundary above a layout to catch it.
    const shellLoad = await loadWithTimeout(
      Promise.all([
        getUnreadCountCached(user.id),
        getOrgMembershipsCached(user.id),
        getOwnedPetsCountCached(user.id),
      ]),
      3_000,
    );
    if (shellLoad.ok) {
      [unreadCount, orgMemberships, ownedPetsCount] = shellLoad.value;
    }
  }

  const displayName = profile?.displayName?.trim() || user?.email?.split("@")[0] || "";

  const shell = resolveShellNav({
    pathname,
    session: profile
      ? {
          role: profile.role as ShellRole,
          displayName,
          orgMemberships,
        }
      : null,
  });

  const parts = displayName.trim().split(/\s+/);
  const initials =
    parts.length >= 2
      ? (parts[0][0] + parts[1][0]).toUpperCase()
      : displayName.slice(0, 2).toUpperCase();

  // The public surface always renders the citizen top-bar. For a citizen
  // (anon → PUBLIC_NAV; owner/vet → OWNER_NAV) we use the resolved role nav.
  // For an institutional operator who wandered onto a public page, the resolver
  // yields the operator variant (left-rail nav of operator hrefs) which has no
  // place in a top horizontal masthead — so we show PUBLIC_NAV here and keep
  // the resolver's guaranteed return to their operator/citizen home (D4).
  const mastheadNav = shell.variant === "citizen" ? shell.nav : PUBLIC_NAV;

  // Bottom tabs follow the logged-in citizen onto public surfaces (their nav
  // here is still OWNER_NAV, so the tabs stay consistent). Anonymous visitors
  // and wandering operators keep the masthead-only chrome — PUBLIC_NAV's
  // browse destinations stay in the drawer, not in tabs.
  const showTabBar = Boolean(user) && shell.variant === "citizen";

  return (
    <AppShell
      variant="citizen"
      banner={<DemoModeBanner enabled={shouldShowDemoBanner(process.env.NEXT_PUBLIC_DEMO_MODE)} />}
      masthead={
        <AppCitizenMasthead
          nav={mastheadNav}
          user={user ? { name: parts[0] || displayName, initials } : null}
          unreadCount={unreadCount}
          showReturn={shell.showReturn}
          returnHref={shell.returnHref}
          switcher={shell.switcher}
          primaryNavInTabBar={showTabBar}
        />
      }
      tabBar={
        showTabBar ? <CitizenTabBar nav={mastheadNav} ownedPetsCount={ownedPetsCount} /> : undefined
      }
    >
      {children}
    </AppShell>
  );
}
