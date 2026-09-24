// Thin admin-portal wrapper — same implementation as the /gob route,
// rendered inside the ADMIN shell (portal-follows-viewer, 2026-07-02).
// The page component carries its own authz guard; chrome comes from
// this segment's admin layout. F3+F7 fusion (2026-07-22): this is the
// admin-scoped mirror of the Directorio hub (Organizaciones/Usuarios/
// Servicios/Credenciales tabs) — the "preferred if cheap" admin story, so an
// admin viewer never bounces into gob chrome. RUPGA's "credenciales" tab has
// no admin-only concept (RUPGA never had an /admin/rupga route), but the tab
// still renders here for a universal-scope admin viewer same as any other
// register.
export { default } from "@/app/gob/directorio/page";
