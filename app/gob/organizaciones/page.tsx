// /gob/organizaciones — ABSORBED into the Directorio hub as the
// "organizaciones" register (F3+F7 fusion, 2026-07-22: PO-approved route
// unification — registry-entity management, identical roster grammar). This
// route now only redirects, preserving every query param (q/verified/
// orgType), into /gob/directorio?registro=organizaciones.
//
// The actual roster lives in ./OrganizacionesScreen.tsx (byte-identical body
// of the former page), imported and rendered by app/gob/directorio/page.tsx
// under the "organizaciones" tab (the default).

import { redirect } from "next/navigation";

import { buildDirectorioHubRedirectUrl } from "@/lib/ui/directorio-hub-redirect";

export default async function GobOrganizacionesRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  redirect(buildDirectorioHubRedirectUrl(sp, "organizaciones", "/gob"));
}
