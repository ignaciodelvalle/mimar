"use client";

/**
 * Wave 2 Item 9 — focus management for form submit errors.
 *
 * When a server-action form returns an error, the browser stays on the page.
 * Per the mobile/a11y spec: "foco al primer error en submit fallido."
 *
 * Usage:
 *   const errorRef = useFormErrorFocus(state.error);
 *   // Attach errorRef to the error <p> element (or the first invalid field):
 *   <p ref={errorRef} role="alert" tabIndex={-1}>{state.error}</p>
 *
 * The hook focuses the element whenever `error` transitions from falsy to
 * truthy (i.e. a new submit failure). Existing error text changes do NOT
 * re-trigger focus (prevents jarring focus jumps on re-renders).
 */
import { useEffect, useRef } from "react";

export function useFormErrorFocus<T extends HTMLElement = HTMLElement>(
  error: string | null | undefined,
): React.RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const prevErrorRef = useRef<string | null | undefined>(null);

  useEffect(() => {
    const hadError = Boolean(prevErrorRef.current);
    const hasError = Boolean(error);

    // Only move focus when error status CHANGES to true (new failure).
    if (!hadError && hasError && ref.current) {
      ref.current.focus({ preventScroll: false });
    }

    prevErrorRef.current = error ?? null;
  }, [error]);

  return ref;
}
