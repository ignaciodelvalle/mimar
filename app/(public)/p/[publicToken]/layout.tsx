// Public credential landing layout — the PII-sensitive token-landing surface
// (spec D13), migrated onto the unified AppShell variant=landing (Item 7,
// Phase C2, the deferred slice of Phase C). A `/p/[publicToken]` QR is scanned
// by a stranger who found a pet: it gets the minimal trust chrome (brand +
// Argentina stripe + "Credencial registrada en miMAR"), NOT the public browse
// chrome. The (public) layout above renders a transparent passthrough for these
// token-landing paths, so this layout owns the single `#main-content`.
//
// resolveShellNav is the single decision: a token-landing path always yields
// the `landing` variant regardless of auth, with a discreet "back to my app"
// return only when there is a session to return to (a logged-in owner scanning
// their own pet's QR still gets a quiet way home).
//
// This layout wraps the credential page AND its finder sub-actions (/encontre,
// /sighting). Each of those pages drops its own full-screen `<main>` — this
// landing shell now owns `#main-content` + min-height (D11). No page content,
// disclosure/Tier gating, rate-limit, data fetching, or PII rendering changes.
//
// THE 404 GATE BELOW (2026-09-23 defect fix — verified with curl).
// `/p/[publicToken]/loading.tsx` gives the credential page an instant
// skeleton, which Next.js implements by wrapping `page.tsx` (and everything
// below it — `encontre/`, `sighting/`) in an automatic `<Suspense>`. An async
// Server Component inside that boundary suspends the moment it awaits, so Next
// flushes the skeleton — committing the response to HTTP 200 — BEFORE
// `page.tsx`'s own `notFound()` for an unknown token ever runs ("the response
// has already begun streaming as a 200, and the status can't change once
// streaming has started", Next's own docs). A missing token answered 200 with
// the not-found BODY, which search engines and monitors read as "this exists".
//
// WHY THE GATE WORKS HERE. Next nests a segment as layout → loading boundary →
// page: this layout WRAPS the Suspense boundary `loading.tsx` creates, so it
// renders OUTSIDE it (and no ancestor segment has a `loading.tsx`). Nothing
// has been flushed while it runs, and a `notFound()` thrown here still sets a
// real 404. (The first version of this comment credited the layout's `getUser()`
// call — an uncached read — for the escape. That was wrong: the escape is the
// boundary's position, and it would hold with no session read at all.)
//
// ONE CHARGE, ONE ROW (second pass, after review). The gate reads through
// `probePublicCredential` (./credential-probe.ts): throttle first, then the pet
// row, memoised per request with `React.cache`. The page reuses both — its door
// gets the same memoised limiter answer and the same row through
// `pageLookupDeps` — so one visit is ONE throttle charge and ONE row read, as
// it was before this gate existed. The heavy view-data fan-out stays in the
// page, behind `loading.tsx`. The first version called the full door here:
// two charges per visit and the whole fan-out twice.
//
// WHAT FALLS THROUGH. Only a definitive `not_found` 404s. `throttled` renders
// `{children}` (each page shows its own throttle notice — a limited caller is
// not told whether the token exists), and `unavailable` (DB failure / blown
// budget) renders `{children}` too, so the page shows its degraded card: an
// outage is never "this token does not exist".
//
// THE SIBLINGS. `/encontre` and `/sighting` had the same 200-for-a-missing-
// token defect and get the same gate. The probe charges the bucket of the
// route actually rendering (`public_token_encontre` / `public_token_sighting`,
// from middleware's `x-pathname`), and the sibling page's own
// `isPublicTokenReadThrottled(...)` reads that same memoised charge — so they
// pay exactly what they paid before: one charge on their own bucket, none on
// `public_token_page`. What they do pay extra is ONE pet-row read (the probe's),
// since their own queries select different columns and were left untouched.
//
// PREFETCHES ARE NOT PROBED (third pass, after the re-review). Next 15
// prefetches a dynamic route down to the nearest `loading.tsx`, and that
// prefetch renders THIS layout. /perdidas and the government lost-pet list
// render a `<Link href="/p/…">` per card, so every visible card cost one
// `public_token_page` limiter write and one pet-row read — a browsing visitor
// spent a finder's budget without opening anything. A router prefetch
// (`isRouterPrefetchRender`) now skips the probe and renders `{children}`:
// nothing is read, so nothing is answered and there is no oracle to throttle.
// The signal comes from Next's work store, not from `headers()` — Next hides
// the prefetch headers from user code, which the first attempt learned on the
// wire; the details are on `isRouterPrefetchRender`. The navigation that
// follows is a normal request and is gated like any visit.
//
// WHAT THE GATE COSTS A VISITOR, AND ITS CEILING. Before this gate existed the
// skeleton flushed immediately. Now, for a found token, the first byte waits
// for the limiter write plus the pet-row read (both memoised, so the page does
// not pay them again). A healthy DB answers both in milliseconds; a HUNG one
// would have held the skeleton for the probe's full pet-row budget
// (PET_ROW_BUDGET_MS, 3 s) on top of the limiter. So the layout waits at most
// LAYOUT_PROBE_BUDGET_MS (1.5 s) and then falls through to `{children}`: the
// skeleton streams, and the page keeps awaiting the SAME memoised probe
// behind it with its own budget. What a timeout gives up is only the real 404
// for that one slow request — an unknown token then gets the page's in-stream
// not-found body with a 200, which is the pre-fix behaviour and leaks nothing
// the throttled probe did not already charge for.

import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/layout/AppShell";
import { DemoModeBanner } from "@/components/ui/DemoModeBanner";
import { shouldShowDemoBanner } from "@/lib/domain/demo-mode";
import { getProfileCached } from "@/lib/infra/request-cache";
import { createClient } from "@/lib/supabase/server";
import { resolveShellNav } from "@/lib/ui/shell-nav";

import {
  type CredentialProbe,
  LAYOUT_PROBE_BUDGET_MS,
  credentialSurfaceFromPath,
  isRouterPrefetchRender,
  probePublicCredential,
} from "./credential-probe";

/** The probe's answer, or `timed_out` once the layout's budget runs out. */
async function probeWithinLayoutBudget(
  publicToken: string,
  surface: ReturnType<typeof credentialSurfaceFromPath>,
): Promise<CredentialProbe | { status: "timed_out" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ status: "timed_out" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timed_out" }), LAYOUT_PROBE_BUDGET_MS);
  });
  try {
    return await Promise.race([probePublicCredential(publicToken, surface), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export default async function PublicCredentialLandingLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;

  // Runs OUTSIDE `{children}`'s Suspense boundary — see the header comment.
  // Only a definitive `not_found` stops here; `throttled`, `unavailable`,
  // `timed_out` and `found` all render `{children}`, which makes its own full determination
  // from the SAME memoised probe.
  // A router prefetch is never probed (see the header): it renders no page
  // and reads nothing, so it must not spend the limiter either.
  if (!isRouterPrefetchRender()) {
    const surface = credentialSurfaceFromPath((await headers()).get("x-pathname"));
    const probe = await probeWithinLayoutBudget(publicToken, surface);
    if (probe.status === "not_found") notFound();
  }

  // Read session purely for the discreet "back to my app" affordance (D13).
  // This is NOT an auth gate — the credential page renders correctly logged-out.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const profile = user ? await getProfileCached(user.id) : null;

  const shell = resolveShellNav({
    pathname: `/p/${publicToken}`,
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
