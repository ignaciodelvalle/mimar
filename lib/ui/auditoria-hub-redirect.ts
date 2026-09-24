// auditoria-hub-redirect — shared param-preserving redirect builder for the
// Auditoría hub (structural convergence 2026-08-02: the /admin audit-trail
// pair collapses into ONE screen — both /admin/historial and /admin/auditoria
// queried the SAME audit_log at the SAME universal admin scope, differing
// only in filter surface and row presentation; /admin/historial's own header
// already said "parity with /admin/auditoria"). /admin/historial no longer
// renders its own list — it permanently redirects into
// /admin/auditoria?vista=actividad&<...original params>, so a bookmarked or
// shared old-route URL (action/actor/period/from/to/cursor — the keyset
// cursor targets the same table and ordering, so it stays valid) lands on the
// exact same slice of data under the hub route.
//
// CRITICAL scope fence: /gob/historial is NOT part of this fusion — the govt
// twin is JURISDICTION-SCOPED ({ kind: "govt", actorIds }) and keeps its own
// standalone route, query and nav entry. Only the two UNIVERSAL-scope admin
// surfaces converge; this helper only ever targets the /admin portal.

export type AuditoriaVista = "sensibles" | "actividad";

/**
 * Builds the redirect target for the old /admin/historial route: every
 * incoming search param is forwarded untouched, then `vista` is set to the
 * given value (applied LAST so it always wins, even if a stale `vista` param
 * was already present on the old URL).
 */
export function buildAuditoriaHubRedirectUrl(
  searchParams: Record<string, string | string[] | undefined>,
  vista: AuditoriaVista,
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
  return `/admin/auditoria?${qs.toString()}`;
}
