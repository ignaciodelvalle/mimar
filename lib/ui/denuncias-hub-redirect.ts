// denuncias-hub-redirect — shared param-preserving redirect builder for F1
// (the Denuncias hub ABSORBS Moderación + Maltrato as stages, 2026-07-22 —
// PO-approved route unification: same worker, same daily moment, same
// decision family). /gob/moderacion and /gob/maltrato no longer render their
// own queue — they permanently redirect into
// /gob/denuncias?etapa=<stage>&<...original params>, so a bookmarked or
// shared old-route URL (including the maltrato inspector's ?caso=/&mascota=/
// &panel= deep-link params, pagination cursors, filters) lands on the exact
// same slice of data under the new hub route. Nested detail routes
// (/gob/moderacion/[id], /gob/maltrato/[id]) are UNCHANGED — they never go
// through this helper.

export type DenunciaHubStage = "moderacion" | "triage";

/**
 * Builds the redirect target for an old stage route: every incoming search
 * param is forwarded untouched, then `etapa` is set to the given stage
 * (applied LAST so it always wins, even if a stale `etapa` param was already
 * present on the old URL).
 */
export function buildDenunciasHubRedirectUrl(
  searchParams: Record<string, string | string[] | undefined>,
  stage: DenunciaHubStage,
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
  qs.set("etapa", stage);
  return `/gob/denuncias?${qs.toString()}`;
}
