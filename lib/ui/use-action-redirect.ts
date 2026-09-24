"use client";

// useActionRedirect — client half of the `redirectTo` post-action navigation
// contract (nav burn-down N3, 2026-07-04).
//
// WHY: server actions in this codebase no longer call next/navigation's
// redirect() on success. Next.js 15.5.x's App Router has a production-mode
// defect where the action's redirect response resolves correctly (the
// mutation commits, the RSC fetch completes with `x-action-redirect`) but
// the client router silently drops the transition — no pushState, no
// re-render, no error (engram #621/#622; verify-report #650 WARNING-1; see
// lib/ui/full-page-action-nav.ts for the full mechanism). Actions instead
// RETURN a form state carrying `redirectTo`, and the calling form mounts
// this hook to perform a full document navigation — the one mechanism
// proven immune to the drop.
//
// Usage (with useActionState):
//   const [state, formAction, isPending] = useActionState(action, initial);
//   useActionRedirect(state.redirectTo, state);
//
// `fireKey` (pass the WHOLE action state) exists because keying the effect on
// the redirect STRING alone silently no-ops when two submissions in one
// mounted document resolve to the identical destination — e.g. a vet
// re-entering the same DIM code after a bfcache back-restore (cursor citizen
// UX C1, verified 2026-07-24): deps unchanged → no navigation, no error, no
// feedback. Each submission returns a NEW state object, so keying on result
// identity re-fires the redirect every time the action succeeds.

import { useCallback, useEffect, useState } from "react";

import { navigateAfterActionSuccess } from "./full-page-action-nav";

/**
 * Fires the post-action navigation and reports whether the document is on its
 * way out, so callers can keep their control busy until it actually leaves.
 *
 * WHY THE RETURN VALUE (X1-F1, external design review)
 * `window.location.assign()` does not block: it starts the fetch and returns.
 * A control gated only on the action's own pending flag therefore re-enables,
 * with its idle label, while the OLD page is still on screen. On a real
 * connection that reads as "Guardando…" → "Crear mascota" enabled again and
 * nothing changed → seconds later, the new page. The impatient user taps again,
 * and most call sites have no UI idempotency guard behind them.
 *
 * `navigating` never goes back down. There is nothing to come back to — the
 * document is leaving — and a flag that could flip false would reopen the exact
 * window this closes.
 *
 * Usage:
 *   const navigating = useActionRedirect(state.redirectTo, state);
 *   <button disabled={isPending || navigating}>
 *     {isPending || navigating ? "Guardando…" : "Guardar"}
 *   </button>
 */
export function useActionRedirect(
  redirectTo: string | null | undefined,
  fireKey?: unknown,
): boolean {
  const [navigating, setNavigating] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies(fireKey): fireKey is a DELIBERATE extra dependency — it is not read inside the effect; its only job is re-firing the redirect when a new submission resolves to the identical destination string (see module comment).
  useEffect(() => {
    if (!redirectTo) return;
    setNavigating(true);
    navigateAfterActionSuccess(redirectTo);
  }, [redirectTo, fireKey]);
  return navigating;
}

/**
 * The imperative twin of useActionRedirect, for call sites that own their own
 * submit handler (a `startTransition` around a direct action call) rather than
 * going through useActionState.
 *
 * Same reason for existing: `window.location.assign()` returns immediately, so
 * a transition's own `pending` drops the moment the handler finishes and the
 * control comes back to life over the old page (X1-F1).
 *
 *   const [navigate, navigating] = useActionNavigate();
 *   <button disabled={pending || navigating}>…</button>
 */
export function useActionNavigate(): [(targetUrl: string) => void, boolean] {
  const [navigating, setNavigating] = useState(false);
  const navigate = useCallback((targetUrl: string) => {
    setNavigating(true);
    navigateAfterActionSuccess(targetUrl);
  }, []);
  return [navigate, navigating];
}
