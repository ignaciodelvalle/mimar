// cuentas-hub-redirect — shared param-preserving redirect builder for the
// Cuentas privilegiadas hub (structural convergence 2026-08-02: /admin/govts
// + /admin/admins collapse into ONE tabbed hub at /admin/cuentas, mirroring
// the F3 Directorio hub shape — privileged-account administration, identical
// roster grammar: search, alta, deactivate). Unlike Directorio's registers,
// the two panels stay DISTINCT under the tabs — different tables and
// onboarding flows (govt_assignments jurisdiction alta/reasignación vs admin
// grant/revoke) — so the hub is a tab shell over two separate screens, never
// a merged query.
//
// /admin/govts and /admin/admins no longer render their own roster — they
// permanently redirect into /admin/cuentas?registro=<register>&<...original
// params>, so a bookmarked or shared old-route URL (search query, status
// filter, test-account toggle) lands on the exact same slice of data under
// the new hub route. Nested detail/form routes (/admin/govts/[userId],
// /admin/govts/new, /admin/admins/[userId], /admin/admins/new) are UNCHANGED
// — they never go through this helper.

export type CuentasRegistro = "govts" | "admins";

/**
 * Builds the redirect target for an old privileged-roster route: every
 * incoming search param is forwarded untouched, then `registro` is set to
 * the given register (applied LAST so it always wins, even if a stale
 * `registro` param was already present on the old URL).
 */
export function buildCuentasHubRedirectUrl(
  searchParams: Record<string, string | string[] | undefined>,
  registro: CuentasRegistro,
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
  return `/admin/cuentas?${qs.toString()}`;
}
