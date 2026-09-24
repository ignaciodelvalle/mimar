// /gob/rupga — ABSORBED into the Directorio hub as the "credenciales"
// register (F3+F7 fusion, 2026-07-22: PO-approved route unification —
// registry-entity management, identical roster grammar). This route now
// only redirects, preserving every query param (q/status), into
// /gob/directorio?registro=credenciales.
//
// The actual roster lives in ./CredencialesScreen.tsx (byte-identical body
// of the former page), imported and rendered by app/gob/directorio/page.tsx
// under the "credenciales" tab.

import { redirect } from "next/navigation";

import { buildDirectorioHubRedirectUrl } from "@/lib/ui/directorio-hub-redirect";

export default async function GobRupgaRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  redirect(buildDirectorioHubRedirectUrl(sp, "credenciales", "/gob"));
}
