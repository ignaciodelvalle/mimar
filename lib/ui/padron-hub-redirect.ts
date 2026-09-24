// padron-hub-redirect — shared param-preserving redirect builder for F8 (the
// Padrón hub ABSORBS Población + Censo as tabbed vistas, 2026-07-22 —
// PO-approved route unification: both are registry-derived Programa surfaces
// the registry manager reads together). /gob/poblacion and /gob/censo (and
// their /admin/* dual-portal twins, which render their OWN admin-only screens
// under the admin Padrón hub — NOT a thin re-export, since the admin bodies
// genuinely diverge from gob's) no longer render their own dashboard — they
// permanently redirect into /gob/padron?vista=<vista>&<...original params> or
// /admin/padron?vista=<vista>&<...original params>, so a bookmarked or shared
// old-route URL (period/from/to/province/locality/species) lands on the exact
// same slice of data under the new hub route, WITHOUT crossing portals
// (portal-follows-viewer: an /admin/* old route redirects into /admin/padron,
// never /gob/padron).

export type PadronVista = "poblacion" | "censo";
export type PadronPortalBase = "/gob" | "/admin";

/**
 * Builds the redirect target for an old Padrón-family route: every incoming
 * search param is forwarded untouched, then `vista` is set to the given
 * value (applied LAST so it always wins, even if a stale `vista` param was
 * already present on the old URL).
 */
export function buildPadronHubRedirectUrl(
  searchParams: Record<string, string | string[] | undefined>,
  vista: PadronVista,
  portalBase: PadronPortalBase = "/gob",
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) qs.append(key, v);
    } else {
      qs.set(key, value);
    }
  }
  qs.set("vista", vista);
  return `${portalBase}/padron?${qs.toString()}`;
}
