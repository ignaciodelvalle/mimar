// /admin/poblacion — ABSORBED into the admin Padrón hub as the "Población"
// vista (F8 fusion, 2026-07-22: PO-approved route unification). This route
// now only redirects, preserving every query param (period/from/to/
// species), into /admin/padron?vista=poblacion.
//
// The actual dashboard lives in ./AdminPoblacionScreen.tsx (byte-identical
// body of the former page), imported and rendered by
// app/admin/padron/page.tsx under the "poblacion" tab (the default) —
// portal-follows-viewer: this redirect stays inside /admin, never bounces
// into gob chrome.

import { redirect } from "next/navigation";

import { buildPadronHubRedirectUrl } from "@/lib/ui/padron-hub-redirect";

export default async function AdminPoblacionRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  redirect(buildPadronHubRedirectUrl(sp, "poblacion", "/admin"));
}
