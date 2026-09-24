"use client";

// lib/use-idempotency-key.ts
//
// Client-side hook that provides a stable UUID v4 idempotency key per form
// mount. The key survives re-renders (useRef) and can be regenerated after
// a successful submission so the same form can be submitted again safely.
//
// Design: ENO Event-Trust Tier 1 Fase B — decisions B2 + B5.
// Spec: docs/superpowers/plans/2026-05-22-event-trust-tier-1.md §4 Fase B
//
// WHY useRef and NOT useState:
//   useState triggers a re-render when the state is first set. useRef holds
//   a mutable box that is stable across renders — the key is initialized
//   once on mount and never causes additional renders.
//
// Manual test plan (no @testing-library/react installed):
//   1. Mount a form that uses useIdempotencyKey. Inspect the hidden input —
//      the value should be a UUID v4 (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx).
//   2. Trigger a re-render (e.g. parent state change). The hidden input value
//      must remain identical.
//   3. Call reset() and verify the hidden input now shows a different UUID v4.
//   4. Submit the same form twice without calling reset(). The second POST must
//      carry the same key → server returns the original row with wasNoop=true.
//   5. Call reset() between submissions. The second POST must carry a new key
//      → server inserts a new row, wasNoop=false.

import { useCallback, useRef } from "react";

export type UseIdempotencyKeyResult = {
  /** Stable UUID v4 key for the current form session. */
  key: string;
  /**
   * Regenerate the key. Call this after a successful form submission so the
   * next submission gets a fresh key and is treated as a distinct event.
   * Returns the new key for convenience.
   */
  reset: () => string;
};

/**
 * Returns a stable UUID v4 idempotency key for a form mount.
 *
 * The key is generated once per mount using `crypto.randomUUID()` and stored
 * in a ref so it survives re-renders without causing them.
 *
 * Call `reset()` after a successful submission to get a fresh key for the
 * next submission.
 */
export function useIdempotencyKey(): UseIdempotencyKeyResult {
  const keyRef = useRef<string>(crypto.randomUUID());

  const reset = useCallback((): string => {
    const next = crypto.randomUUID();
    keyRef.current = next;
    return next;
  }, []);

  return { key: keyRef.current, reset };
}
