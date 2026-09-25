// Who may use the padrón sanitario export (/gob/analytics/export) — the ONE
// predicate. The page renders "Sin acceso" when it is false, the server action
// refuses, and the /gob rail hides the "Exportar padrón sanitario" entry
// (components/layout/nav-presets.ts gobNavSectionsFor). Three readers, one rule:
// before this module each held its own copy, and the rail held none — a govt
// official with no assigned jurisdiction was offered a menu entry that led to
// a lock screen (PO, 2026-09-25).
//
// admin → yes (universal scope). govt → only with at least one assignment: the
// export is jurisdiction-scoped, and zero assignments is zero rows to export.
// Any other role (national included) → no: the page's own guard
// (requireAdminOrGovtOrRedirect) turns it away before this predicate is asked.

export function canExportPadronSanitario(
  role: string,
  jurisdictions: ReadonlyArray<unknown>,
): boolean {
  return role === "admin" || (role === "govt" && jurisdictions.length > 0);
}
