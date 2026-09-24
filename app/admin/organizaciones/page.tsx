// /admin/organizaciones — ABSORBED into the admin Directorio hub as the
// "organizaciones" register (F3+F7 fusion, 2026-07-22: PO-approved route
// unification). This route now only redirects, preserving every query
// param, into /admin/directorio?registro=organizaciones — portal-follows-
// viewer: an admin old-route bookmark lands on the ADMIN hub, never
// /gob/directorio.
//
// The actual roster lives in app/gob/organizaciones/OrganizacionesScreen.tsx
// (byte-identical body of the former page), imported and rendered by
// app/gob/directorio/page.tsx (mirrored at app/admin/directorio/page.tsx)
// under the "organizaciones" tab.

import { redirect } from "next/navigation";

import { buildDirectorioHubRedirectUrl } from "@/lib/ui/directorio-hub-redirect";

export default async function AdminOrganizacionesRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  redirect(buildDirectorioHubRedirectUrl(sp, "organizaciones", "/admin"));
}
