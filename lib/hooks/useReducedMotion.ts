"use client";

// useReducedMotion — whether the user asked the OS to reduce motion.
//
// The single source for the reduced-motion FLOOR that every JS-driven animation
// (count-up numbers, map paint/camera easing, reveals) must honor. CSS already
// has a global `prefers-reduced-motion` reset in globals.css; this hook is its
// runtime twin for animations that live in JS/RAF, not CSS.

import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Returns `true` when the user prefers reduced motion.
 *
 * SSR-safe: defaults to `false` on the first render (so server/client markup
 * match — the non-animated value is the same static number either way), then
 * reads the real preference inside a `useEffect` and subscribes to changes.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(QUERY);
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return reduced;
}
