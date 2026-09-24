// operativos-hub-redirect — shared param-preserving redirect builder for F2
// (the Operativos hub ABSORBS Campañas + Alcance comunitario as tabs,
// 2026-07-22 — PO-approved route unification: the field coordinator planning
// the week needs both "where do I intervene" (alcance) and "how are launched
// campaigns converting" (campañas) in one place). /gob/campanas and
// /gob/outreach no longer render their own dashboards — they permanently
// redirect into /gob/operativos?vista=<tab>&<...original params>, so a
// bookmarked or shared old-route URL (including campañas' period/province/
// locality/kind filters) lands on the exact same slice of data under the new
// hub route. Nested drill-down routes (/gob/campanas/export,
// /gob/outreach/export) are UNCHANGED — they never go through this helper.

export type OperativosHubTab = "campanas" | "alcance";

/**
 * Builds the redirect target for an old Operativos-family route: every
 * incoming search param is forwarded untouched, then `vista` is set to the
 * given tab (applied LAST so it always wins, even if a stale `vista` param
 * was already present on the old URL).
 */
export function buildOperativosHubRedirectUrl(
  searchParams: Record<string, string | string[] | undefined>,
  tab: OperativosHubTab,
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
  qs.set("vista", tab);
  return `/gob/operativos?${qs.toString()}`;
}
