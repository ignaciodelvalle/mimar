// /admin/govts — ABSORBED into the Cuentas privilegiadas hub as the "govts"
// register (privileged-accounts fusion, 2026-08-02, mirroring the F3
// Directorio hub shape). This route now only redirects, preserving every
// query param (q/status/test), into /admin/cuentas?registro=govts.
//
// The actual roster lives in ./GovtsScreen.tsx (relocated body of the former
// page), imported and rendered by app/admin/cuentas/page.tsx under the
// "Cuentas gobierno" tab. The nested detail/form routes
// (/admin/govts/[userId], /admin/govts/new) are UNCHANGED — jurisdiction
// alta/reasignación and deactivation keep living there.

import { redirect } from "next/navigation";

import { buildCuentasHubRedirectUrl } from "@/lib/ui/cuentas-hub-redirect";

export default async function AdminGovtsRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  redirect(buildCuentasHubRedirectUrl(sp, "govts"));
}
