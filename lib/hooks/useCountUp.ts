"use client";

// useCountUp — animates a number from its PREVIOUS value to a new one when the
// target changes ("conteo arriba o abajo"), so a KPI reads its delta viscerally
// instead of snapping. RAF-based, zero dependencies.
//
// Behavior: tween ON CHANGE only — the first render (and every render where the
// target is unchanged) returns the exact target, so there is no distracting
// count-up-from-zero on mount or on unrelated re-renders. Honors reduced motion
// (jumps straight to the target). SSR-safe (returns the target verbatim on the
// server; the tween is a client-only useEffect).

import { useEffect, useRef, useState } from "react";

import { useReducedMotion } from "./useReducedMotion";

/**
 * Returns a value that eases toward `target` (ease-out cubic) over `durationMs`
 * whenever `target` changes. Reduced motion or `durationMs <= 0` → the exact
 * target, no animation.
 *
 * `startAt` (optional): the value the FIRST render eases FROM — a mount reveal
 * (e.g. `0` → count up on load). Omit for the default (start at the target, so
 * only later changes animate).
 */
export function useCountUp(target: number, durationMs = 600, startAt?: number): number {
  const reduced = useReducedMotion();
  const initial = startAt ?? target;
  const [value, setValue] = useState(initial);
  const fromRef = useRef(initial);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const from = fromRef.current;
    if (reduced || durationMs <= 0 || from === target) {
      setValue(target);
      fromRef.current = target;
      return;
    }

    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - (1 - t) ** 3; // ease-out cubic
      setValue(from + (target - from) * eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      // Land on the target if interrupted mid-tween, so the next change eases
      // from the true current target, not a frozen intermediate value.
      fromRef.current = target;
    };
  }, [target, durationMs, reduced]);

  return value;
}
