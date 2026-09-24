import { Suspense } from "react";

import { PanoramaBoardSkeleton } from "@/components/panorama/PanoramaBoardSkeleton";
import { PanoramaShell } from "@/components/panorama/PanoramaShell";
import { GOB_ALL_PROVINCES } from "@/lib/analytics/govt-dashboards";
import { shouldShowDemoBanner } from "@/lib/domain/demo-mode";
import { listLocalitiesByProvince, listLocalityCentroids } from "@/lib/infra/ar-localidades";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import {
  type PanoramaBoardSearchParams,
  buildPanoramaBoard,
} from "@/lib/panorama/build-panorama-board";
import type { ProvinceCode } from "@/lib/reference/ar-provincias";
import { resolvePanoramaRequestScope } from "@/src/modules/panorama/application/resolve-request-scope";
import { DEFAULT_PANORAMA_PRESET_ID } from "@/src/modules/panorama/domain/presets";

// Centro de Situación Nacional — admin view (universal scope).
// Slice 2: dark local basemap + multi-layer console + unified filters.
//
// WP3 (decrowding): the board assembly shared with /gob/panorama lives in
// lib/panorama/build-panorama-board.ts; this page keeps only what is genuinely
// admin-specific — the national default preset, the centroid-derived
// initialBounds, GOB_ALL_PROVINCES and the demo-banner suppression.
export const dynamic = "force-dynamic";

type PanoramaSearchParams = Promise<PanoramaBoardSearchParams>;

// RESILIENCE (2026-07-10, PO instrumented-review finding #1): the board's slow
// default-layer seed used to be awaited at the TOP of this page component,
// blocking the very first byte for up to PAGE_BUDGET_MS while the generic
// route-group "Cargando…" skeleton hung. It now streams behind this <Suspense>
// so the outer function returns synchronously — the operator chrome + a bounded
// panorama skeleton paint immediately, and the seeded board flushes when ready.
// A throw inside the board is caught by app/admin/panorama/error.tsx (a real
// "reintentar" state), never a perpetual skeleton.
export default function AdminPanoramaPage({
  searchParams,
}: {
  searchParams: PanoramaSearchParams;
}) {
  return (
    <Suspense fallback={<PanoramaBoardSkeleton />}>
      <AdminPanoramaBoard searchParams={searchParams} />
    </Suspense>
  );
}

async function AdminPanoramaBoard({
  searchParams,
}: {
  searchParams: PanoramaSearchParams;
}) {
  const { profile, jurisdictions } = await requireAdminOrGovtOrRedirect();
  const sp = await searchParams;

  // Selected province/locality from the filters, narrowed to the viewer's
  // standing by the SHARED resolver (same block as /gob/panorama and the two
  // panorama API routes). Admin: [] means universal scope and the ?province/
  // ?locality selection becomes the admin DRILL; a govt user reaching this
  // route (requireAdminOrGovtOrRedirect admits both) is narrowed via
  // narrowGovtScope with whole-province subsumption (critique of PR #762,
  // finding 4).
  const scope = await resolvePanoramaRequestScope({
    role: profile.role,
    jurisdictions,
    province: sp.province,
    locality: sp.locality,
  });
  const { provinceObj, localityRow } = scope;

  const [localities, localityCentroids] = provinceObj
    ? await Promise.all([
        listLocalitiesByProvince(provinceObj.code as ProvinceCode),
        listLocalityCentroids(provinceObj.code as ProvinceCode),
      ])
    : [[], {} as Record<string, [number, number]>];

  // Map autozoom (B3): the SituationalMap fits `initialBounds` on mount. Without
  // it, the map only fits to the active layer's feature bbox — so a selected
  // province whose default ("perdidas") layer is sparse never zooms in and reads
  // as a blank national frame. Derive the province bounding box from its locality
  // centroids ([lng,lat]); when a single locality is picked, tighten to a small
  // box around its centroid. Undefined at the national level (fit to features).
  const initialBounds: [[number, number], [number, number]] | undefined = (() => {
    if (!provinceObj) return undefined;
    const centroidValues = Object.values(localityCentroids);
    if (localityRow) {
      const c = localityCentroids[localityRow.localitySlug];
      if (c) {
        const [lng, lat] = c;
        const d = 0.2; // ~22km halo so the locality isn't a hairline point
        return [
          [lng - d, lat - d],
          [lng + d, lat + d],
        ];
      }
    }
    if (centroidValues.length === 0) return undefined;
    let minLng = Number.POSITIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLng = Number.NEGATIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    for (const [lng, lat] of centroidValues) {
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    }
    return [
      [minLng, minLat],
      [maxLng, maxLat],
    ];
  })();

  const board = await buildPanoramaBoard({
    role: profile.role,
    jurisdictions,
    sp,
    scope,
    // Seed level follows the SCOPE, not the preset (PO-ratified 2026-07-09; QA
    // 2026-07-03): a selected province/locality opens at LOCALITY granularity;
    // the national view seeds at PROVINCE, matching the console's zoomed-out
    // hysteresis derivation so there is no drift/refetch on mount (C2).
    seedLevel: provinceObj ? ("locality" as const) : ("province" as const),
    // Admin's role-default vista (see src/modules/panorama/domain/presets.ts):
    // the national welfare overview, seeded server-side on a first visit.
    defaultPresetId: DEFAULT_PANORAMA_PRESET_ID,
    routeLabel: "admin/panorama",
  });

  return (
    <PanoramaShell
      {...board}
      allowedProvinces={GOB_ALL_PROVINCES}
      localities={localities}
      localityCentroids={localityCentroids}
      initialBounds={initialBounds}
      // /admin shows the global DemoModeBanner (admin layout); suppress
      // Panorama's own notice so the page never stacks two disclosures (D3).
      suppressDemoDisclosure={shouldShowDemoBanner(process.env.NEXT_PUBLIC_DEMO_MODE)}
    />
  );
}
