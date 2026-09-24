// /admin/admins — ABSORBED into the Cuentas privilegiadas hub as the
// "admins" register (privileged-accounts fusion, 2026-08-02, mirroring the
// F3 Directorio hub shape). This route now only redirects, preserving every
// query param (q/test), into /admin/cuentas?registro=admins.
//
// The actual roster lives in ./AdminsScreen.tsx (relocated body of the
// former page), imported and rendered by app/admin/cuentas/page.tsx under
// the "Administradores" tab. The nested detail/form routes
// (/admin/admins/[userId], /admin/admins/new) are UNCHANGED — grant/revoke
// and deactivation keep living there.

import { redirect } from "next/navigation";

import { buildCuentasHubRedirectUrl } from "@/lib/ui/cuentas-hub-redirect";

export default async function AdminAdminsRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  redirect(buildCuentasHubRedirectUrl(sp, "admins"));
}
