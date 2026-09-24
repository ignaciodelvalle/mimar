// The org portal layout's shell reads, under ONE deadline (T1-L18).
//
// app/org/[orgToken]/layout.tsx awaited three reads bare before its bounded
// badge block: the membership check, the profile (for the rail's name) and the
// granted capabilities (for the nav). Its own comment on the badge block says
// why that is a bug — a degraded pooler does not reject, it hangs, and this
// layout wraps every /org/* route, so one hung read took the whole portal down
// with no error boundary to catch it (Next does not wrap a segment's own
// layout in its sibling error.tsx). The badge counts got a deadline on
// 2026-08-09; the three reads in front of them did not.
//
// The three share one budget, measured from the start of the first read:
//
//   - the membership check is the security boundary. If it does not finish in
//     time the layout cannot render the portal at all — it renders an honest
//     degraded state instead of children it has not authorised. Next's own
//     control flow (notFound for a non-member, redirect for no session) still
//     propagates: loadWithTimeout re-throws those sentinels.
//   - the profile and the capabilities are UX, not the gate (the pages
//     re-check capabilities defensively). They get whatever is left of the same
//     budget, and on a timeout or error the rail renders with no name and the
//     capability-gated nav items hidden — the degradation the capabilities read
//     already had for a rejection.
//
// Generic over the session and capability types on purpose: importing them
// (even as types) from the DB layer would move this module's test out of the
// unit project. The layout injects the real readers.

import { type AnalyticsLoad, loadWithTimeout } from "@/lib/analytics/analytics-load";

/** Budget for the layout's shell reads, all three together. */
export const ORG_SHELL_BUDGET_MS = 5_000;

export type OrgShellDeps<S extends { user: { id: string } }, C> = {
  requireAccess: (orgToken: string) => Promise<S>;
  getProfile: (userId: string) => Promise<{ displayName: string } | null>;
  getGranted: (session: S) => Promise<Set<C>>;
  /** Injectable clock, so the shared budget is testable. */
  now?: () => number;
};

export type OrgShellAccess<S, C> = {
  session: S;
  displayName: string;
  granted: Set<C>;
  /** True when the profile/capabilities reads missed the budget or failed. */
  navDegraded: boolean;
};

export async function loadOrgShellAccess<S extends { user: { id: string } }, C>(
  orgToken: string,
  deps: OrgShellDeps<S, C>,
  budgetMs: number = ORG_SHELL_BUDGET_MS,
): Promise<AnalyticsLoad<OrgShellAccess<S, C>>> {
  const now = deps.now ?? Date.now;
  const startedAt = now();

  const access = await loadWithTimeout(deps.requireAccess(orgToken), budgetMs);
  if (!access.ok) return access;
  const session = access.value;

  // What is left of the SAME budget — not a fresh one per read, or three
  // sequential reads could take three budgets.
  const remaining = Math.max(0, budgetMs - (now() - startedAt));
  const extras = await loadWithTimeout(
    Promise.all([deps.getProfile(session.user.id), deps.getGranted(session)]),
    remaining,
  );
  const [profile, granted] = extras.ok ? extras.value : [null, new Set<C>()];

  return {
    ok: true,
    value: {
      session,
      displayName: profile?.displayName ?? "",
      granted,
      navDegraded: !extras.ok,
    },
  };
}
