"use client";

// Client-side lazy wrapper for SituationalMap.
// next/dynamic with ssr:false must live in a "use client" module — it cannot be
// invoked from a Server Component in Next.js 15. maplibre-gl (~200KB gz) stays
// out of the initial route chunk behind this boundary.
//
// The loading skeleton is a DARK canvas (not the light pulse the choropleth
// uses) so the flagship console never flashes a white panel before the map
// paints.
import dynamic from "next/dynamic";
import { memo } from "react";

const LazySituationalMap = dynamic(() => import("./SituationalMap").then((m) => m.SituationalMap), {
  ssr: false,
  loading: () => (
    // ARCHETYPE A full-bleed: fill the console's viewport-relative sizer (the
    // map card is `h-full`), not a fixed 560px, so the skeleton doesn't jump.
    <div
      className="h-full min-h-[440px] w-full animate-pulse rounded-[var(--radius-lg)] border border-ln-op-line"
      style={{ background: "#0b1020" }}
      aria-hidden="true"
    />
  ),
});

// memo() here, not inside SituationalMap.tsx: that file is AT its file-size
// ratchet limit (3398/3398 lines, zero headroom — perf sweep 2026-08-02).
// The console re-renders 3-4×/1100ms in play mode; the call site
// (PanoramaConsole.tsx) already passes memoized/primitive props, so wrapping
// this thin dynamic-import boundary skips the re-render without touching the
// map's own file.
export const SituationalMapDynamic = memo(LazySituationalMap);
