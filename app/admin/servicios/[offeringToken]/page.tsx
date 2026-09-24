// Thin admin-portal wrapper — same implementation as the /gob route,
// rendered inside the ADMIN shell (portal-follows-viewer, 2026-07-02).
// The page component carries its own authz guard; chrome comes from
// this segment's admin layout.
export { default } from "@/app/gob/servicios/[offeringToken]/page";
