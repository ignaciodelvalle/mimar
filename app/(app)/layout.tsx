// Authenticated owner-portal layout. Any page rendered under this route group
// (`app/(app)/...`) requires the user to be (a) logged in and (b) a
// personal-account role (owner or vet). Institutional accounts (admin, govt)
// don't own pets or have appointments, so the whole owner portal is a no-op
// for them — bounce them to the portal their role does belong in.
//
// Visual chrome: the unified AppShell, variant=citizen (Item 7, Phase C). The
// nav is resolved by resolveShellNav from the session — for an owner that is
// always OWNER_NAV, with a guaranteed role-return on off-home surfaces (D4).
// Auth + role gates are unchanged.
//
// Strangler note: this drops LnOwnerNav + LnOwnerSubBar usage. Those files are
// NOT deleted here — Phase D removes them.

import { loadWithTimeout } from "@/lib/analytics/analytics-load";
import { BRANDING } from "@/lib/ui/branding";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { AppCitizenMasthead } from "@/components/layout/AppCitizenMasthead";
import { AppFooter } from "@/components/layout/AppFooter";
import { AppShell } from "@/components/layout/AppShell";
import { CitizenTabBar } from "@/components/layout/CitizenTabBar";
import { ServiceWorkerRegistrar } from "@/components/pwa/ServiceWorkerRegistrar";
import { DeactivatedAccountBanner } from "@/components/ui/DeactivatedAccountBanner";
import { DemoModeBanner } from "@/components/ui/DemoModeBanner";
import { IdentityPendingBanner } from "@/components/ui/IdentityPendingBanner";
import { LnMaintenanceScreen } from "@/components/ui/MaintenanceScreen";
import { LnOfflineBanner } from "@/components/ui/OfflineBanner";
import { shouldShowDemoBanner } from "@/lib/domain/demo-mode";
import { isIdentityPending } from "@/lib/domain/identity-completeness";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { isPlatformInMaintenance } from "@/lib/infra/live-user";
import {
  getOrgMembershipsCached,
  getOwnedPetsCountCached,
  getProfileCached,
  getUnreadCountCached,
} from "@/lib/infra/request-cache";
import { type ShellRole, resolveShellNav } from "@/lib/ui/shell-nav";
import { AppSessionUnavailable } from "./_components/AppSessionUnavailable";

// A funcionario works with three portals open at once, and all four of them
// returned the ROOT title verbatim — "miMAR — Mi Mascota Argentina" — so the
// browser tabs were indistinguishable (QA 2026-08-07). The public routes were
// already fine; only the authenticated portals inherited.
//
// `template` rather than a flat string: a page that sets its own title gets
// "Denuncias · Gobierno — miMAR", and one that sets none falls back to
// `default`. The portal name is the part that has to survive truncation in a
// narrow tab, so it goes before the brand.
export const metadata: Metadata = {
  title: {
    default: `Mis mascotas — ${BRANDING.appName}`,
    template: `%s · Mis mascotas — ${BRANDING.appName}`,
  },
};

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Maintenance kill-switch short-circuits BEFORE any auth/data fetch — no
  // masthead/nav data exists yet, so the screen renders full-page, unwrapped.
  if (isPlatformInMaintenance()) {
    return <LnMaintenanceScreen />;
  }

  // BOUNDED, and this pair is the reason the block below was not enough.
  //
  // The counters further down were wrapped in 2026-08 with a comment saying a
  // degraded pooler must not hang every route at once. It could still hang all
  // of them, one line above that guard: `requireUserOrRedirect` goes to Supabase
  // Auth and then reads the profile, and `getProfileCached` is a bare
  // `React.cache()` — memoisation, no deadline. So the layout protected the tab
  // bar's badges and left the two round-trips that decide whether the page
  // renders at all completely open. Measured 2026-09-17 while auditing which
  // citizen screens actually degrade; the comment below described a protection
  // the code did not provide.
  //
  // A LAYOUT HAS NO ERROR BOUNDARY OF ITS OWN, so there is nothing to fall into:
  // a hang here is an infinite skeleton on every owner route simultaneously, and
  // the `loading.tsx` files underneath make it look healthier than it is.
  //
  // 8s, not the counters' 3s. These two are on the critical path — nothing
  // renders without them — so the deadline has to be long enough that a merely
  // slow network does not lock somebody out of their own portal. The counters
  // can be dropped after three seconds because the cost is a missing badge.
  //
  // `loadWithTimeout` re-throws Next's control-flow sentinels
  // (`unstable_rethrow`, added the same day), so `requireUserOrRedirect`'s own
  // redirect to the login screen still reaches the framework instead of being
  // folded into `{ok:false}`. Without that this wrapper would send every
  // signed-out visitor to a degraded panel instead of to sign-in.
  const sessionLoad = await loadWithTimeout(
    (async () => {
      const { user } = await requireUserOrRedirect();
      return { user, profile: await getProfileCached(user.id) };
    })(),
    8_000,
  );
  if (!sessionLoad.ok) {
    // NOT `children`. We do not know who this is, so rendering the owner portal
    // would be rendering somebody's private surface on a guess. The honest
    // answer names the failure and offers the only useful action.
    return <AppSessionUnavailable reason={sessionLoad.reason} correlationId={sessionLoad.id} />;
  }
  const { user, profile } = sessionLoad.value;
  if (profile?.role === "admin") redirect("/admin");
  if (profile?.role === "govt") redirect("/gob");

  // ownedPetsCount drives the tab bar's centre slot (D.8): with zero pets the
  // capture action is a no-op, so the slot becomes "Registrar mascota" instead.
  // One indexed count per request — the documented cost (see
  // getOwnedPetsCountCached); nothing else in this layout touches ownerships.
  // BOUNDED (2026-08-09). Three cached counters in the LAYOUT of the whole
  // owner portal: a degraded pooler hangs every /mis-mascotas, /notificaciones
  // and /cuenta route at once, and a layout has no error boundary of its own to
  // fall into. 3s, and the nav degrades to its zero-state rather than the
  // portal degrading to nothing.
  const shellLoad = await loadWithTimeout(
    Promise.all([
      getUnreadCountCached(user.id),
      getOrgMembershipsCached(user.id),
      getOwnedPetsCountCached(user.id),
    ]),
    3_000,
  );
  const [unreadCount, orgMemberships, ownedPetsCount] = shellLoad.ok
    ? shellLoad.value
    : ([0, [], 0] as typeof shellLoad extends { ok: true; value: infer V } ? V : never);

  // displayName is NOT NULL in the DB, but an empty string would render a
  // blank nav avatar — fall back to the email prefix like the pre-cache code.
  const displayName = profile?.displayName?.trim() || user.email?.split("@")[0] || "";

  // The request pathname (injected by middleware) drives the off-home return
  // affordance. Absent it (e.g. in a non-middleware render), default to the
  // role home so showReturn resolves to false rather than crashing.
  const pathname = (await headers()).get("x-pathname") ?? "/inicio";

  // Recovery path for an abandoned signup step 2 (staging finding 2026-08-01).
  // Re-derived from the profile row on EVERY request — the abandoned state used
  // to live in a React useState on /signup and died with the tab. Sending the
  // user back to `pathname` means completing the profile never costs them the
  // page they were on.
  const identityPending = isIdentityPending({
    displayName: profile?.displayName,
    email: user.email,
  });

  const shell = resolveShellNav({
    pathname,
    session: {
      role: (profile?.role ?? "owner") as ShellRole,
      displayName,
      orgMemberships,
    },
  });

  const parts = displayName.trim().split(/\s+/);
  const initials =
    parts.length >= 2
      ? (parts[0][0] + parts[1][0]).toUpperCase()
      : displayName.slice(0, 2).toUpperCase();

  return (
    <AppShell
      variant="citizen"
      banner={
        <>
          <DemoModeBanner enabled={shouldShowDemoBanner(process.env.NEXT_PUBLIC_DEMO_MODE)} />
          {/* The standing explanation for a self-deactivated account. It has to
              live in the LAYOUT and not on /cuenta alone: requireLiveUser now
              refuses every write from this account, and the refusal happens
              wherever the person happens to be. DEACTIVATED is the one liveness
              refusal requireUserOrRedirect deliberately passes (auth-guards.ts),
              so this layout renders for them — which is exactly why the banner
              can be the surface instead of a route to be redirected to.
              `deactivatedAt` comes free with the already-cached profile. */}
          <DeactivatedAccountBanner deactivated={profile?.deactivatedAt != null} />
          <IdentityPendingBanner pending={identityPending} returnTo={pathname} />
          <LnOfflineBanner />
        </>
      }
      // PO quick win X1 (2026-07-24): the owner home is pet-first — the
      // legal/institutional footer cluster collapses under a closed <details>
      // here ONLY (public marketing surfaces via app/(public)/layout.tsx keep
      // the full footer — see AppFooter's `collapsed` prop doc).
      footer={<AppFooter collapsed />}
      masthead={
        <AppCitizenMasthead
          nav={shell.nav}
          user={{ name: parts[0] || displayName, initials }}
          unreadCount={unreadCount}
          showReturn={shell.showReturn}
          returnHref={shell.returnHref}
          switcher={shell.switcher}
          primaryNavInTabBar
        />
      }
      // Mobile bottom tabs own primary nav for the logged-in citizen
      // (native-mobile audit §1); the masthead drawer keeps only
      // secondary/overflow content.
      tabBar={<CitizenTabBar nav={shell.nav} ownedPetsCount={ownedPetsCount} />}
    >
      {/* Web Push v1: registers /sw.js for the owner portal only. No-op unless
          NEXT_PUBLIC_PUSH_ENABLED is set and the browser supports push. */}
      <ServiceWorkerRegistrar />
      {children}
    </AppShell>
  );
}
