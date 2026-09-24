"use client";

// use-retryable-action — dispatch-level catch for transient transport failures
// on idempotent mutation forms (degraded-states 2026-08-06, design D5/D6).
//
// WHAT THIS COVERS
// A server-action dispatch that REJECTS client-side (503 from the platform, an
// aborted connection) normally surfaces as an unhandled error: the nearest
// error boundary unmounts the form and the owner's typed input is gone. This
// wrapper catches the rejection INSIDE the useActionState dispatch and returns
// a form state instead — `{ ...prev, error, transientFailure: true }` — so the
// form stays mounted and typed input survives exactly the way it already does
// on a validation-error re-render (EventFormState convention,
// src/modules/events/actions.ts).
//
// MutationErrorCard (components/ui/MutationErrorCard.tsx) renders on
// `transientFailure` and replays the SAME <form> via requestSubmit(): the
// hidden `clientIdempotencyKey` input is untouched (useIdempotencyKey resets
// only explicitly), so the retry carries the SAME key and a server-persisted
// write resolves as confirmation (`wasNoop`/`redirectTo`), never a duplicate.
//
// WHITELIST BOUNDARY (structural, design D6): the `idempotencyKey` option is
// REQUIRED. A form that has no client idempotency key cannot wire retry
// without lying about it — which is the point: retry-with-key is only safe on
// surfaces whose server writer dedupes on `clientIdempotencyKey`.
//
// Whitelisted surfaces (verified server-side dedupe, __tests__/
// idempotency-guards.test.ts):
//   - VaccinationForm  (eventos/nuevo/vacuna — createVaccinationAction)
//   - DewormingForm    (eventos/nuevo/antiparasitario — createDewormingAction)
//
// DISJOINT FROM D.12 BY CONSTRUCTION: AtenderStallNotice observes a submit
// STILL PENDING at 8s; this wrapper only acts when the dispatch REJECTED
// (pending already cleared). No shared state, no code path where both fire
// for one submission. No file under app/org/[orgToken]/atender/ is touched.

import { useMemo } from "react";

import { MUTATION_RETRY_COPY } from "@/lib/ui/degraded-states";

/**
 * Minimum shape of a form state this wrapper can extend. `transientFailure`
 * marks a state produced by a caught transport rejection — the ONLY producer
 * is this wrapper; server actions never set it.
 */
export type RetryableFormState = {
  error: string | null;
  transientFailure?: boolean;
};

export type UseRetryableActionOptions = {
  /**
   * The form's `clientIdempotencyKey` (from useIdempotencyKey). Not consumed
   * at runtime — the hidden input is the single carrier of the key — but
   * REQUIRED so that a form without server-side dedupe cannot compile-wire
   * retry semantics (Idempotency Whitelist Boundary).
   */
  idempotencyKey: string;
};

/** Next.js control-flow errors (redirect/notFound) must never be swallowed. */
function isNextControlFlowError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("digest" in err)) return false;
  const digest = (err as { digest?: unknown }).digest;
  return typeof digest === "string" && digest.startsWith("NEXT_");
}

/**
 * Wraps a server-action reference for useActionState so a transport rejection
 * becomes a recoverable `transientFailure` state instead of an unmount.
 *
 * Usage:
 *   const { key: idempotencyKey } = useIdempotencyKey();
 *   const retryable = useRetryableAction(action, { idempotencyKey });
 *   const [state, formAction, isPending] = useActionState(retryable, initial);
 */
export function useRetryableAction<S extends RetryableFormState>(
  action: (prev: S, formData: FormData) => Promise<S>,
  options: UseRetryableActionOptions,
): (prev: S, formData: FormData) => Promise<S> {
  if (!options.idempotencyKey) {
    // Loud, immediate, and impossible to ship past a smoke test: an empty key
    // means the surface is NOT actually carrying its dedupe key.
    throw new Error(
      "useRetryableAction requires the form's clientIdempotencyKey — retry-with-key is only safe on surfaces with verified server-side dedupe.",
    );
  }

  return useMemo(
    () =>
      async (prev: S, formData: FormData): Promise<S> => {
        try {
          return await action(prev, formData);
        } catch (err) {
          if (isNextControlFlowError(err)) throw err;
          return {
            ...prev,
            error: MUTATION_RETRY_COPY.cause,
            transientFailure: true,
          };
        }
      },
    [action],
  );
}
