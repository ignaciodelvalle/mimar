// /gob/campanas — ABSORBED into the Operativos hub as the "Campañas" tab (F2
// fusion, 2026-07-22: PO-approved route unification — same worker, same
// weekly planning moment). This route now only redirects, preserving every
// query param (period/from/to/province/locality/kind), into
// /gob/operativos?vista=campanas.
//
// The actual dashboard lives in ./CampanasScreen.tsx (byte-identical body of
// the former page), imported and rendered by app/gob/operativos/page.tsx
// under the "campanas" tab. /gob/campanas/export is UNCHANGED — nested
// drill-down routes don't move.

import { redirect } from "next/navigation";

import { buildOperativosHubRedirectUrl } from "@/lib/ui/operativos-hub-redirect";

export default async function GobCampanasRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  redirect(buildOperativosHubRedirectUrl(sp, "campanas"));
}
