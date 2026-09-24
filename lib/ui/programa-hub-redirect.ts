// programa-hub-redirect — shared param-preserving redirect builder for F9 (the
// Programa hub ABSORBS Analítica as a tabbed vista, 2026-08-01 — PO decision
// after an external QA gate: two nav destinations shared one noun. The
// briefing alerts said "Ver en Programa →" and landed on /gob/programa, while
// four KPI tiles on the jurisdiction panel landed on /gob/analytics, whose h1
// read "Analítica". Two paths that sound alike must not land on two different
// screens — an operator who discovers that stops trusting the nav).
//
// /gob/analytics no longer renders its own dashboard — it permanently
// redirects into /gob/programa?vista=analitica&<...original params>, so a
// bookmarked or shared old-route URL (period/from/to/province/locality) lands
// on the exact same slice of data under the hub route. /gob/analitica (the
// typo alias) redirects HERE too, directly — not through /gob/analytics — so
// no visitor ever pays for two hops.
//
// /gob/analytics/export is UNCHANGED: it is a child form route with its own
// searchParams contract, not a view of the dashboard. Admin has no analytics
// twin under this name (/admin/inteligencia is a separate surface, deliberately
// untouched by F9), so this only ever targets the /gob portal.

export type ProgramaVista = "resumen" | "analitica";

/**
 * Builds the redirect target for an old Analítica-family route: every incoming
 * search param is forwarded untouched, then `vista` is set to the given value
 * (applied LAST so it always wins, even if a stale `vista` param was already
 * present on the old URL).
 */
export function buildProgramaHubRedirectUrl(
  searchParams: Record<string, string | string[] | undefined>,
  vista: ProgramaVista,
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
  return `/gob/programa?${qs.toString()}`;
}
