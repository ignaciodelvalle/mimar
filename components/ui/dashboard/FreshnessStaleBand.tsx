"use client";

// FreshnessStaleBand — amber staleness band for dashboard freshness footers
// (degraded-states 2026-08-06, design D3).
//
// Mounted once inside DashboardFreshnessFooter (RSC), so all of its call
// sites gain the band with zero call-site edits.
//
// CLOCK MODEL (clock-skew immune by construction): the band never compares a
// client clock against a server timestamp. It measures elapsed time since its
// own client mount — `Date.now()` diffed against `Date.now()` — and the
// render→mount delta is seconds, noise at a 10-minute threshold. When the
// page live-refreshes its data, the parent RSC re-renders and serializes a
// NEW `refreshSignal`, which resets the elapsed clock: a page refreshing
// before the threshold never shows the band (spec: Live-updating page
// suppresses stale band). The signal is an opaque change-detection token —
// its VALUE is never compared to the client clock.
//
// "Actualizar" is a plain `<a href="">` — a full-document GET of the current
// URL, same fence-free mechanism as DegradedFallback's Reintentar.

import {
  STALE_BAND_ACTION,
  STALE_BAND_AFTER_MS,
  STALE_BAND_SLOT_ID,
  staleBandLabel,
} from "@/lib/ui/degraded-states";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// One tick per minute: the copy has minute granularity, so a finer interval
// would only burn battery.
const TICK_MS = 60_000;

function StaleAnchor() {
  return (
    // biome-ignore lint/a11y/useValidAnchor: empty href IS the contract — a full-document GET of the CURRENT URL (design D3; same rationale as DegradedFallback's Reintentar, reconciliation #1979).
    <a href="" className="font-semibold text-[var(--color-st-warn)] underline">
      {STALE_BAND_ACTION}
    </a>
  );
}

export function FreshnessStaleBand({ refreshSignal }: { refreshSignal: string }) {
  const [elapsedMs, setElapsedMs] = useState(0);
  // Resolved after mount: `document` does not exist during SSR, and the slot is
  // rendered by AppShell higher up the tree. Null → render in place, which is
  // exactly the pre-portal behaviour (see STALE_BAND_SLOT_ID).
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setSlot(document.getElementById(STALE_BAND_SLOT_ID));
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies(refreshSignal): refreshSignal is a DELIBERATE extra dependency — it is not read inside the effect; its only job is restarting the elapsed clock when the parent RSC re-renders with fresh data (same convention as lib/ui/use-action-redirect.ts's fireKey).
  useEffect(() => {
    // Fresh data just arrived (new serialized signal) — restart the clock.
    const mountedAt = Date.now();
    setElapsedMs(0);
    const id = setInterval(() => {
      setElapsedMs(Date.now() - mountedAt);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [refreshSignal]);

  if (elapsedMs <= STALE_BAND_AFTER_MS) return null;

  const minutes = Math.floor(elapsedMs / 60_000);
  // <output> is the semantic element for role="status" (same convention as the
  // loading.tsx skeletons; Biome useSemanticElements enforces it).
  //
  // Full-width band rather than the old `inline-block` chip: at the top of the
  // shell it is a page-level notice about everything below it, and a chip
  // floating at the left edge of a full-width row reads as decoration. Bottom
  // border instead of a box — it separates itself from the content it qualifies
  // without drawing a second card.
  const band = (
    <output className="block w-full border-b border-[var(--color-st-warn-bd)] bg-[var(--color-sk-warn-wash)] px-6 py-1.5 text-xs text-[var(--color-st-warn)]">
      {staleBandLabel(minutes)} · <StaleAnchor />
    </output>
  );

  return slot ? createPortal(band, slot) : band;
}
