import { redirect } from "next/navigation";
import { Suspense } from "react";

import {
  deriveWidestJurisdiction,
  isProvinceInGovtScope,
  resolveSeedLocalitySlug,
} from "@/app/gob/panorama/derive-widest-jurisdiction";
import { NoticeToast } from "@/components/gob/NoticeToast";
import { PanoramaBoardSkeleton } from "@/components/panorama/PanoramaBoardSkeleton";
import { PanoramaShell } from "@/components/panorama/PanoramaShell";
import { resolveSeedLevel } from "@/components/panorama/situational-map-utils";
import { GOB_ALL_PROVINCES } from "@/lib/analytics/govt-dashboards";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import {
  listLocalitiesByProvince,
  listLocalityCentroids,
  localityByName,
} from "@/lib/infra/ar-localidades";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import { jurisdictionBounds } from "@/lib/infra/gov-scope";
import { recordSurfaceVisit } from "@/lib/infra/surface-visits";
import {
  type PanoramaBoardSearchParams,
  buildPanoramaBoard,
} from "@/lib/panorama/build-panorama-board";
import type { ProvinceCode } from "@/lib/reference/ar-provincias";
import { provinceByName } from "@/lib/reference/ar-provincias";
import { resolvePanoramaRequestScope } from "@/src/modules/panorama/application/resolve-request-scope";
import { DEFAULT_PANORAMA_PRESET_ID, type PresetId } from "@/src/modules/panorama/domain/presets";

// Centro de Situación Nacional — gobierno view (jurisdiction scope).
// govt sees only its assigned jurisdictions (intersection inherited from the
// scope-aware loaders); admin viewing /gob/* gets universal scope.
//
// WP3 (decrowding): the board assembly shared with /admin/panorama lives in
// lib/panorama/build-panorama-board.ts; this page keeps only what is genuinely
// gob-specific — the widest-jurisdiction derivation + out-of-scope bounce, the
// division seeding (initialDivision*), the jurisdiction-derived provinces list
// and bounds, and the role-aware default vista.
export const dynamic = "force-dynamic";

// scopeLabel lives in lib/panorama/scope-label.ts (shared with /admin/panorama
// so both routes render the same honest scope string for a bounded operator).

// BUG FIX (widest-jurisdiction default): deriveWidestJurisdiction /
// resolveSeedLocalitySlug live in ./derive-widest-jurisdiction.ts, not here —
// a page.tsx may only export the framework's reserved names (`default`,
// `metadata`, `dynamic`, ...); the generated route type-check hard-fails on
// any other named export. See that module for the full contract + doc
// comments; unit-tested in __tests__/derive-widest-jurisdiction.test.ts.

type PanoramaSearchParams = Promise<PanoramaBoardSearchParams>;

// RESILIENCE (2026-07-10, PO instrumented-review finding #1): the board's slow
// default-layer seed used to be awaited at the TOP of this page component,
// blocking the very first byte for up to PAGE_BUDGET_MS while the generic
// route-group "Cargando…" skeleton hung. It now streams behind this <Suspense>
// so the outer function returns synchronously — the operator chrome + a bounded
// panorama skeleton paint immediately, and the seeded board flushes when ready.
// A throw inside the board is caught by app/gob/panorama/error.tsx (a real
// "reintentar" state), never a perpetual skeleton.
export default function GobPanoramaPage({
  searchParams,
}: {
  searchParams: PanoramaSearchParams;
}) {
  return (
    <>
      {/* G1: fires the "fuera de alcance" toast after an out-of-scope bounce. */}
      <NoticeToast />
      <Suspense fallback={<PanoramaBoardSkeleton />}>
        <GobPanoramaBoard searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function GobPanoramaBoard({
  searchParams,
}: {
  searchParams: PanoramaSearchParams;
}) {
  const { user, profile, jurisdictions } = await requireGobReadAccessOrRedirect();
  const sp = await searchParams;

  // Effective scope via the SHARED resolver (same block as /admin/panorama and
  // the two panorama API routes): a govt user cannot widen scope by crafting
  // ?province=&locality= params (narrowGovtScope with whole-province
  // subsumption — critique of PR #762, finding 4); admin gets the drill names.
  // NOTE: the resolver performs its (read-only, alias-tolerant) localityByName
  // lookup BEFORE the out-of-scope bounce below — on the rare bounced request
  // that is one wasted lookup, never a behavior change (the redirect target
  // derives from `widest`, not from the resolved locality).
  const scope = await resolvePanoramaRequestScope({
    role: profile.role,
    jurisdictions,
    province: sp.province,
    locality: sp.locality,
  });
  const { provinceObj, localityRow } = scope;

  // BUG FIX (widest-jurisdiction default): the operator's widest jurisdiction,
  // derived robustly from their assignments (see helper). Admin (no assignments)
  // and multi-province operators resolve to national. PRESENTATION-ONLY — this
  // seeds the client `initialDivision*` props, NEVER a server redirect to
  // ?province/?locality (that would re-enter narrowGovtScope and could loop with
  // the client mount-seed). The DATA scope stays enforced by the scoped loaders.
  const widest = !hasNationalReadScope(profile.role)
    ? deriveWidestJurisdiction(jurisdictions)
    : { provinceCode: null as string | null, localityName: null as string | null };

  // G1 (govt/public honesty): a GOVT operator who requests a ?province OUTSIDE
  // their jurisdiction must NOT be shown a hollow foreign-province shell (map +
  // caption naming a province they cannot act on, KPIs "—", a 500-locality
  // dropdown). Hard-refuse and BOUNCE to their widest in-scope jurisdiction with
  // an honest notice. ADMIN is universal → exempt (any province is valid).
  //
  // Loop-safety: the bounce target is derived from the operator's OWN assignments
  // (deriveWidestJurisdiction), so the re-entered request is always in scope and
  // re-passes this guard. A multi-province / no-scope operator (provinceCode null)
  // bounces to the bare panorama (implicit scope, no ?province) — which likewise
  // never re-triggers the guard. It is a presentation redirect, never a narrowing
  // loop with narrowGovtScope.
  if (!hasNationalReadScope(profile.role) && provinceObj) {
    if (!isProvinceInGovtScope(jurisdictions, provinceObj.code)) {
      const params = new URLSearchParams();
      if (widest.provinceCode) params.set("province", widest.provinceCode);
      // Preserve the operator's grain: a barrio-scoped govt operator must bounce
      // back to their barrio, not widen to the whole province/city. The locality
      // is seeded into initialDivisionLocality below via the sp.locality path.
      if (widest.localityName) params.set("locality", widest.localityName);
      params.set("notice", "fuera-de-alcance");
      redirect(`/gob/panorama?${params.toString()}`);
    }
  }

  // T4-O3 (gob-onboarding-checklist, G2) — record the visit only once the
  // request is confirmed in-scope (past the fuera-de-alcance bounce above), so
  // a request that never actually reaches the board can't flip the step.
  // Best-effort, never blocks/fails this render (see surface-visits.ts).
  await recordSurfaceVisit(user.id, "panorama");

  // The province whose localities/centroids the console needs: an explicit URL
  // drill wins; otherwise the operator's implicit single-province jurisdiction so
  // a scoped operator's division outlines + locality autozoom resolve on mount.
  const scopeProvinceCode: ProvinceCode | null =
    (provinceObj?.code as ProvinceCode | undefined) ?? (widest.provinceCode as ProvinceCode | null);
  const [localities, localityCentroids] = scopeProvinceCode
    ? await Promise.all([
        listLocalitiesByProvince(scopeProvinceCode),
        listLocalityCentroids(scopeProvinceCode),
      ])
    : [[], {}];

  // BUG FIX: single-locality operator → resolve the locality NAME to its SLUG so
  // the console can seed `selectedLocalityCenter` (the console keys centroids by
  // slug) and autozoom to it on load. Only when the URL didn't already pin a
  // province (an explicit drill owns the view). Reuses the alias-tolerant
  // localityByName resolver, so the slug always matches the loaded centroid map.
  const seedLocalityRow =
    !provinceObj && widest.localityName && scopeProvinceCode
      ? await localityByName(scopeProvinceCode, widest.localityName)
      : null;
  // Seed the barrio/locality view whenever the URL names one — the implicit
  // widest-jurisdiction path above (no ?province) OR an explicit ?locality
  // (a manual drill, or the fuera-de-alcance bounce that now preserves the
  // operator's barrio). Without the localityRow fallback, a barrio-scoped govt
  // operator bounced back to scope widened to province/city grain.
  const initialDivisionLocality =
    resolveSeedLocalitySlug(seedLocalityRow) ?? resolveSeedLocalitySlug(localityRow);

  // allowedProvinces: admin → all 24; govt → derive from assigned jurisdictions.
  // Resolve each province code with the ALIAS-TOLERANT provinceByName (not the
  // alias-fragile PROVINCE_ISO_MAP, which lacked the CABA long-form key and could
  // empty the set — dropping a single-province operator to national). The display
  // name stays the operator's stored name for switcher continuity.
  const allowedProvinces = hasNationalReadScope(profile.role)
    ? GOB_ALL_PROVINCES
    : Array.from(new Set(jurisdictions.map((j) => j.province)))
        .map((name) => ({ code: provinceByName(name)?.code ?? "", name }))
        .filter((p) => p.code !== "");

  // Single-province govt scope: the operator's assignments all fall within ONE
  // province. Their scope is IMPLICIT (inherited from the session — they never
  // pick a province in the JurisdictionSwitcher), so `selectedProvinceCode`
  // stays null and the always-visible administrative divisions (barrios for
  // CABA, departamentos elsewhere) never render (PO validation 2026-07-07).
  // Derive the effective division province from the resolved allowedProvinces
  // (deduped by province) so the console activates that province's divisions on
  // mount, exactly as an explicit ?province selection would. Multi-province or
  // admin/national scope → undefined (provinces basemap until an explicit pick).
  // PRESENTATION-ONLY: the data scope is unchanged (scoped loaders enforce it).
  // Derived from the robust widest-jurisdiction resolution (provinceByName) so an
  // alias-form province name can never empty it and drop the operator to national.
  const initialDivisionProvince = widest.provinceCode ?? undefined;

  // A1 (2026-07-31) — the SEED axis, from the SAME predicate the console derives
  // its own axis from. Both seed paths in the shared builder read this: the C2
  // invariant is that `initialLevel` matches the cache the seeded features are
  // placed in AND the axis the console resolves on mount.
  //
  // The old predicate here was `jurisdictions.length > 0` — "has ANY assignment".
  // The console's `resolveDataLevel` reads "has a SINGLE committed province"
  // (derivedProvince = effectiveScopeProvince ?? initialDivisionProvince, which
  // deriveWidestJurisdiction empties for a MULTI-province operator). For an
  // operator whose assignments span two provinces the two disagreed on every
  // load: the server seeded "locality", the console immediately derived
  // "province" and flipped — the level drift this comment block has always
  // claimed the seed avoids. Both seed accounts are multi-province
  // (govt@dim.test: Tierra del Fuego + Santa Cruz), so the drift fired on every
  // QA login. Reading the SAME value the console reads makes the mount quiet
  // again. Single-province and explicit-?province operators are unaffected —
  // initialDivisionProvince is set for them, exactly as before.
  const seedLevel = resolveSeedLevel({
    hasProvinceScope: provinceObj !== null || initialDivisionProvince !== undefined,
    hasLocalityScope: initialDivisionLocality !== undefined,
  });

  // Role-aware default vista (audit-ratified 2026-07-09): the first-visit preset
  // follows the operator's urgent question. A jurisdiction (govt) operator opens
  // on local syndromic surveillance ("sintomas" — base síntomas density + señal
  // de zoonosis, locality-level, framing-less so it stays in THEIR jurisdiction),
  // the sanitary-surveillance question they act on; an admin viewing /gob keeps
  // the national overview default. Presentation-only — respects the URL ?preset
  // contract (applied only on a bare first visit; never overrides an explicit
  // board). The server-seeded default LAYER (perdidas) is unchanged; this only
  // steers the client's first-visit preset auto-activation.
  const defaultPresetId: PresetId = hasNationalReadScope(profile.role)
    ? DEFAULT_PANORAMA_PRESET_ID
    : "sintomas";

  // Govt → bbox of their assigned localities; admin (jurisdictions=[]) → null.
  // Cheap static lookup, needed by both the first-visit and normal paths.
  const initialBounds = await jurisdictionBounds(jurisdictions);

  const board = await buildPanoramaBoard({
    role: profile.role,
    jurisdictions,
    sp,
    scope,
    seedLevel,
    defaultPresetId,
    routeLabel: "gob/panorama",
  });

  return (
    <PanoramaShell
      {...board}
      allowedProvinces={allowedProvinces}
      localities={localities}
      localityCentroids={localityCentroids}
      initialBounds={initialBounds ?? undefined}
      initialDivisionProvince={initialDivisionProvince}
      initialDivisionLocality={initialDivisionLocality}
    />
  );
}
