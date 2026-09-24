// /gob/outreach — ABSORBED into the Operativos hub as the "Alcance
// comunitario" tab (F2 fusion, 2026-07-22: PO-approved route unification —
// same worker, same weekly planning moment). This route now only redirects,
// preserving every query param, into /gob/operativos?vista=alcance.
//
// The actual pipelines live in ./AlcanceScreen.tsx (byte-identical body of
// the former page), imported and rendered by app/gob/operativos/page.tsx
// under the "alcance" tab. /gob/outreach/export is UNCHANGED — nested
// drill-down routes don't move.

import { redirect } from "next/navigation";

import { buildOperativosHubRedirectUrl } from "@/lib/ui/operativos-hub-redirect";

export default async function GobOutreachRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  redirect(buildOperativosHubRedirectUrl(sp, "alcance"));
}
