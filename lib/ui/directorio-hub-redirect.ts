// directorio-hub-redirect — shared param-preserving redirect builder for
// F3+F7 (the Directorio hub ABSORBS Organizaciones + Usuarios + Servicios +
// RUPGA credentials as tabs, 2026-07-22 — PO-approved route unification:
// registry-entity management, identical roster grammar). /gob/organizaciones,
// /gob/usuarios, /gob/servicios, /gob/rupga (and their /admin/* dual-portal
// twins for organizaciones/usuarios/servicios) no longer render their own
// roster — they permanently redirect into
// /gob/directorio?registro=<register>&<...original params> or
// /admin/directorio?registro=<register>&<...original params>, so a bookmarked
// or shared old-route URL (search query, filters, pagination) lands on the
// exact same slice of data under the new hub route, WITHOUT crossing portals
// (portal-follows-viewer: an /admin/* old route redirects into
// /admin/directorio, never /gob/directorio). Nested detail routes
// (/gob/servicios/[offeringToken], /admin/servicios/[offeringToken]) are
// UNCHANGED — they never go through this helper.

export type DirectorioRegistro = "organizaciones" | "usuarios" | "servicios" | "credenciales";
export type DirectorioPortalBase = "/gob" | "/admin";

/**
 * Builds the redirect target for an old Directorio-family route: every
 * incoming search param is forwarded untouched, then `registro` is set to
 * the given register (applied LAST so it always wins, even if a stale
 * `registro` param was already present on the old URL).
 */
export function buildDirectorioHubRedirectUrl(
  searchParams: Record<string, string | string[] | undefined>,
  registro: DirectorioRegistro,
  portalBase: DirectorioPortalBase = "/gob",
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
  qs.set("registro", registro);
  return `${portalBase}/directorio?${qs.toString()}`;
}
