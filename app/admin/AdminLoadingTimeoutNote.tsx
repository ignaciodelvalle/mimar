"use client";

// AdminLoadingTimeoutNote — Cowork I2 (staging QA 2026-07-17).
//
// The /admin dashboard's loading.tsx skeleton can sit forever if the async page
// hangs, leaving the operator with no signal and no way out. This client note
// mounts inside the skeleton and stays INVISIBLE for the first ~12s. On a normal
// (<12s) load Next replaces loading.tsx with the page long before the timer
// fires, so it never flashes; only a genuinely stuck load reaches the threshold
// and reveals the note + a full-reload "Reintentar" affordance.
//
// The skeletons stay put — this appears beneath them, not instead of them.

import { useEffect, useState } from "react";

import { OpButton } from "@/components/ui/dashboard/OpButton";

/** How long the skeleton may sit before we surface the "still loading" note. */
const SLOW_LOAD_MS = 12_000;

export function AdminLoadingTimeoutNote() {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_LOAD_MS);
    return () => clearTimeout(timer);
  }, []);

  if (!slow) return null;

  return (
    <div className="mt-6 flex flex-wrap items-center gap-3 text-sm text-ln-op-ink-2">
      <p className="m-0">La carga está tardando más de lo normal.</p>
      <OpButton variant="ghost" size="sm" onClick={() => window.location.reload()}>
        Reintentar
      </OpButton>
    </div>
  );
}
