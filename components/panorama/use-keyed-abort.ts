"use client";

// useKeyedAbort — per-key AbortController registry (panorama-redesign Fase 1).
//
// Backs the Panorama fetch cancellation: each logical fetch path owns a key
// (layer id for /api/panorama/[layer], "kpis" for the KPI strip). Requesting a
// signal for a key ABORTS the prior in-flight controller for that key and
// hands out a fresh signal — last click wins per key; distinct keys never
// interfere. Everything outstanding is aborted on unmount.
//
// CORRECTNESS RULE (design-mandated): every catch block on a fetch wrapped
// with these signals must start with
//   if (err instanceof DOMException && err.name === "AbortError") return;
// an abort is a SUPERSEDED request, not a failure — it must never run the
// failure branch (which would set active:false and deactivate the layer).

import { useCallback, useEffect, useRef } from "react";

export function useKeyedAbort(): {
  /** Abort+replace the prior controller for `key`; returns the fresh signal. */
  signalFor: (key: string) => AbortSignal;
  /** Abort every outstanding controller (also runs automatically on unmount). */
  abortAll: () => void;
} {
  const controllersRef = useRef<Map<string, AbortController>>(new Map());

  const signalFor = useCallback((key: string): AbortSignal => {
    controllersRef.current.get(key)?.abort();
    const next = new AbortController();
    controllersRef.current.set(key, next);
    return next.signal;
  }, []);

  const abortAll = useCallback(() => {
    for (const controller of controllersRef.current.values()) controller.abort();
    controllersRef.current.clear();
  }, []);

  // Abort outstanding fetches when the owning component unmounts.
  useEffect(() => abortAll, [abortAll]);

  return { signalFor, abortAll };
}
