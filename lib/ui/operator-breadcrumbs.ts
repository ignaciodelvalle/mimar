// Pure, side-effect-free breadcrumb derivation for the gob and admin portals.
// Input: a pathname string + the target portal.
// Output: an ordered list of { label, href? } items suitable for OpCrumbs.
//
// Rules:
//   - The first crumb is always the portal root ("Briefing"), linked.
//   - The second crumb is the section label derived from the nav presets.
//   - Additional depth is capped: any dynamic id/token segment gets a generic
//     "Detalle" label instead of echoing raw ids (PII / ugliness concern).
//   - On the portal root itself, a single unlabeled-root crumb is returned.
//
// Kept in a non-"use server" module so it can be imported by client components
// and tested with Vitest without any server-only constraints.

import { ADMIN_NAV_SECTIONS, GOB_NAV_SECTIONS } from "@/components/layout/nav-presets";
import type { CrumbItem } from "@/components/ui/dashboard/OpCrumbs";

export type OperatorPortal = "gob" | "admin";

// ---------------------------------------------------------------------------
// Label maps derived from nav presets at module initialisation time.
// ---------------------------------------------------------------------------

/** Build a segment → label map from the flat items of a nav section list. */
function buildSegmentMap(
  sections: (typeof GOB_NAV_SECTIONS)[number][],
  portalPrefix: string,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const section of sections) {
    for (const item of section.items) {
      // Strip the portal prefix to get just the segment key (e.g. "vigilancia").
      const withoutPrefix = item.href.startsWith(`${portalPrefix}/`)
        ? item.href.slice(portalPrefix.length + 1)
        : null;
      if (!withoutPrefix) continue;
      // Only use the FIRST path segment as the key (ignore deeper nav hrefs).
      const firstSeg = withoutPrefix.split("/")[0];
      if (firstSeg && !map.has(firstSeg)) {
        map.set(firstSeg, item.label);
      }
    }
  }
  return map;
}

const GOB_SEGMENT_MAP = buildSegmentMap(GOB_NAV_SECTIONS, "/gob");
const ADMIN_SEGMENT_MAP = buildSegmentMap(ADMIN_NAV_SECTIONS, "/admin");

// Segments that are NOT top-level nav items (so they get no label from the nav
// presets) but show up as crumbs — without these they fell to capitalise() and
// rendered as raw English/segment text ("Govts", "New", "Admins"). Admin
// fresh-sweep A4.
//
// NOTE: do NOT list a segment here if it IS a top-level nav item AND its
// label genuinely differs by portal — the static label wins over the nav
// preset (see labelForSegment) and would override a portal-specific label.
// None of the entries below hit that case today (checked against both
// GOB_NAV_SECTIONS and ADMIN_NAV_SECTIONS at the time each was added).
const STATIC_SEGMENT_LABELS: Record<string, string> = {
  govts: "Gobiernos",
  admins: "Administradores",
  new: "Nueva cuenta",
  nueva: "Nueva",
  nuevo: "Nuevo",
  reglas: "Reglas",
  editar: "Editar",
  usuarios: "Usuarios",
  // "investigaciones" is 16 chars — isLikelyId() would misclassify it as a
  // token. List it here so /gob/vigilancia/investigaciones resolves correctly.
  investigaciones: "Investigaciones",
  analytics: "Analítica",
  export: "Exportación",
  // F1 fusion (2026-07-22): /gob/moderacion and /gob/maltrato were removed
  // from GOB_NAV_SECTIONS (absorbed into the Denuncias hub as stages), so
  // GOB_SEGMENT_MAP no longer carries their labels. Their [id] detail routes
  // stay put, though, and this breadcrumb still derives a section crumb from
  // the pathname's first segment for them — pin the labels explicitly so
  // "moderacion" doesn't fall through to capitalise() and lose its accent
  // ("Moderacion" instead of "Moderación"). "maltrato" needs no accent fix
  // (capitalise() already produces the right word) but is listed for the
  // same reason: don't rely on that being a coincidence.
  moderacion: "Moderación",
  maltrato: "Maltrato",
  // F2 fusion (2026-07-22): /gob/campanas and /gob/outreach were removed from
  // GOB_NAV_SECTIONS (absorbed into the Operativos hub as tabbed vistas), so
  // GOB_SEGMENT_MAP no longer carries their labels. Their /export drill-down
  // routes stay put — pin the labels explicitly (same reasoning as
  // moderacion/maltrato above: "campanas" would otherwise capitalise to
  // "Campanas", losing the ñ).
  campanas: "Campañas",
  outreach: "Alcance comunitario",
  // F3+F7 fusion (2026-07-22): /gob/organizaciones, /gob/servicios and
  // /gob/rupga (plus their /admin/organizaciones, /admin/servicios twins)
  // were removed from nav (absorbed into the Directorio hub as tabbed
  // registros) — pin their labels explicitly for the same reason. "usuarios"
  // was already listed above (portal-identical label, unaffected). "rupga"
  // needs an explicit expansion, not a capitalised acronym.
  organizaciones: "Organizaciones",
  servicios: "Servicios",
  rupga: "Credenciales RUPGA",
};

/** Localized label for a path segment. The static map wins over the nav-preset
 * label so non-localized nav labels (e.g. "Admins", "Govts") render localized in
 * crumbs; falls back to the nav label, then a capitalised segment. */
function labelForSegment(segment: string, segmentMap: Map<string, string>): string {
  return STATIC_SEGMENT_LABELS[segment] ?? segmentMap.get(segment) ?? capitalise(segment);
}

// ---------------------------------------------------------------------------
// Root labels and base paths per portal.
// ---------------------------------------------------------------------------

// The root label MUST stay in lockstep with the unlabeled-top nav item in
// components/layout/nav-presets.ts (GOB_NAV_SECTIONS / ADMIN_NAV_SECTIONS):
// the crumb and the rail entry name the SAME destination, and a crumb reading
// "Panel › Panorama" beside a rail reading "Briefing" would reintroduce the
// two-nouns-one-screen confusion this rename removed (PO decision 2026-08-01).
// /org is unaffected — its crumbs come from OrgBreadcrumbs.tsx and keep "Panel".
const PORTAL_META: Record<OperatorPortal, { rootLabel: string; base: string }> = {
  gob: { rootLabel: "Briefing", base: "/gob" },
  admin: { rootLabel: "Briefing", base: "/admin" },
};

// ---------------------------------------------------------------------------
// Public pure function.
// ---------------------------------------------------------------------------

/**
 * Derive an ordered breadcrumb list from a pathname for an operator portal.
 *
 * @param pathname  The current pathname (e.g. "/gob/maltrato/abc-123").
 * @param portal    Which portal this pathname belongs to ("gob" | "admin").
 * @returns         Ordered array of CrumbItem for OpCrumbs.
 */
export function deriveOperatorCrumbs(pathname: string, portal: OperatorPortal): CrumbItem[] {
  const { rootLabel, base } = PORTAL_META[portal];
  const segmentMap = portal === "gob" ? GOB_SEGMENT_MAP : ADMIN_SEGMENT_MAP;

  const rootCrumb: CrumbItem = { label: rootLabel, href: base };

  // Normalise: ensure no trailing slash and starts with base.
  const normalised = pathname.replace(/\/+$/, "");

  if (normalised === base || normalised === "") {
    // We're on the portal root — single crumb, no link (current page).
    return [{ label: rootLabel }];
  }

  if (!normalised.startsWith(`${base}/`)) {
    // Pathname doesn't belong to this portal — return just the root.
    return [rootCrumb];
  }

  const rest = normalised.slice(base.length + 1); // e.g. "maltrato/abc-123"
  const segments = rest.split("/").filter(Boolean);

  if (segments.length === 0) {
    return [{ label: rootLabel }];
  }

  const [firstSeg, ...deeperSegs] = segments;

  // Look up the human label: nav presets → static segment map → capitalised.
  const sectionLabel = labelForSegment(firstSeg ?? "", segmentMap);

  if (deeperSegs.length === 0) {
    // e.g. /gob/vigilancia — two crumbs, last is current (no link).
    return [rootCrumb, { label: sectionLabel }];
  }

  // Deeper path — add a "Detalle" crumb for the dynamic segment.
  // We intentionally do NOT echo raw ids/tokens as labels (PII / ugliness).
  // If there are multiple deeper segments (e.g. /admin/jurisdicciones/ar/bs/lp/reglas)
  // we collapse them all into a single "Detalle" crumb rather than leaking internal ids.
  const sectionCrumb: CrumbItem = { label: sectionLabel, href: `${base}/${firstSeg}` };

  // Check whether the second segment is itself a known sub-section nav item
  // (e.g. /admin/jurisdicciones/... where the deeper path is NOT an id/token).
  // A heuristic: if the deeper segment looks like a uuid or short token (contains
  // hyphens, is long, or matches a hex pattern), treat it as an id → "Detalle".
  // Otherwise try to resolve it as a sub-section label.
  const secondSeg = deeperSegs[0] ?? "";
  // A segment that appears in STATIC_SEGMENT_LABELS is always a known sub-path
  // regardless of its length. Check this before the isLikelyId heuristic to
  // prevent long-but-static words (e.g. "investigaciones", 16 chars) from being
  // misclassified as dynamic tokens.
  const isKnownStatic = secondSeg in STATIC_SEGMENT_LABELS || segmentMap.has(secondSeg);
  const looksLikeId = !isKnownStatic && isLikelyId(secondSeg);

  if (!looksLikeId && deeperSegs.length === 1) {
    // Known static sub-path — treat as a deeper section label (localized).
    const subLabel = labelForSegment(secondSeg, segmentMap);
    return [rootCrumb, sectionCrumb, { label: subLabel }];
  }

  return [rootCrumb, sectionCrumb, { label: "Detalle" }];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Heuristic: does this segment look like a dynamic id / token?
 * Matches UUIDs, nanoid-style strings, numeric ids, and public tokens.
 * Static named sub-routes (e.g. "recibidos", "nuevo") return false.
 */
function isLikelyId(segment: string): boolean {
  if (!segment) return false;
  // UUID v4 pattern
  if (/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(segment)) return true;
  // Purely numeric
  if (/^\d+$/.test(segment)) return true;
  // Nanoid / cuid / public-token: 15+ chars with mixed alphanumeric
  if (segment.length >= 15 && /^[a-zA-Z0-9_-]+$/.test(segment)) return true;
  // 2-letter country/province codes are static (e.g. /admin/jurisdicciones/ar)
  if (segment.length <= 3 && /^[a-z]+$/i.test(segment)) return false;
  return false;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
