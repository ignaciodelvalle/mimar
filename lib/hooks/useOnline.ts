"use client";

// useOnline — tracks the browser's network connectivity state.
//
// New convention: lib/hooks/ is the first hooks-location directory in this
// repo (no lib/hooks/ or hooks/ existed before this file). Client-only hooks
// with no natural home under lib/domain (server-safe) or lib/ui (SSR-friendly
// pure helpers) live here going forward.

import { useEffect, useState } from "react";

/**
 * Returns whether the browser currently reports a network connection.
 *
 * SSR-safe: defaults to `true` on the very first render so server and client
 * markup match (no hydration mismatch) — the real `navigator.onLine` value is
 * only read inside a `useEffect`, which then subscribes to the browser's
 * `online`/`offline` window events for the lifetime of the caller.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(navigator.onLine);

    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return online;
}
