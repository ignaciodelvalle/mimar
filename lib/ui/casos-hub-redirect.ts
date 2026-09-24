// casos-hub-redirect — shared param-preserving redirect builder for F6 (the
// Casos hub ABSORBS Disputas as an "expediente" tab, 2026-07-22 — PO-approved
// route unification: same worker, same legal-administrative operator grammar
// — open/parties/resolve — for both regulatory cases and custody disputes).
// /gob/disputas no longer renders its own queue — it permanently redirects
// into /gob/casos?expediente=disputas&<...original params>, so a bookmarked
// or shared old-route URL (including its `status` filter) lands on the exact
// same slice of data under the new hub route. The nested detail route
// (/gob/disputas/[disputeToken]) is UNCHANGED — it never goes through this
// helper. Admin has no /admin/disputas twin (disputes are a /gob-only
// surface), so this only ever targets the /gob portal.

export type CasosExpediente = "casos" | "disputas";

/**
 * Builds the redirect target for the old /gob/disputas route: every incoming
 * search param is forwarded untouched, then `expediente` is set to the given
 * value (applied LAST so it always wins, even if a stale `expediente` param
 * was already present on the old URL).
 */
export function buildCasosHubRedirectUrl(
  searchParams: Record<string, string | string[] | undefined>,
  expediente: CasosExpediente,
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
  qs.set("expediente", expediente);
  return `/gob/casos?${qs.toString()}`;
}
