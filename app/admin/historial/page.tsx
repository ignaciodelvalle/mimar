// /admin/historial — ABSORBED into the Auditoría hub as the "Actividad" vista
// (audit-trail fusion, 2026-08-02: both admin surfaces queried the SAME
// audit_log at the SAME universal admin scope — this page's own header said
// "parity with /admin/auditoria" — so the pair collapsed into one tabbed
// hub). This route now only redirects, preserving every query param
// (action/actor/period/from/to/cursor — same table, same keyset ordering, so
// the cursor stays valid), into /admin/auditoria?vista=actividad.
//
// The actual screen lives in ./ActividadScreen.tsx (relocated body of the
// former page), imported and rendered by app/admin/auditoria/page.tsx under
// the "Actividad" tab.
//
// /gob/historial is UNCHANGED — the govt twin is JURISDICTION-SCOPED and
// stays a standalone route with its own nav entry; only the two admin
// universal-scope surfaces converge.

import { redirect } from "next/navigation";

import { buildAuditoriaHubRedirectUrl } from "@/lib/ui/auditoria-hub-redirect";

export default async function AdminHistorialRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  redirect(buildAuditoriaHubRedirectUrl(sp, "actividad"));
}
