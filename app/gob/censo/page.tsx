// /gob/censo — ABSORBED into the Padrón hub as the "Censo" vista (F8
// fusion, 2026-07-22: PO-approved route unification — both are
// registry-derived Programa surfaces the registry manager reads together).
// This route now only redirects, preserving every query param (period/from/
// to/province/locality/species), into /gob/padron?vista=censo.
//
// The actual dashboard lives in ./CensoScreen.tsx (byte-identical body of
// the former page), imported and rendered by app/gob/padron/page.tsx under
// the "censo" tab. /gob/censo/export is UNCHANGED — it's an API route, not
// a page, and keeps reading the same query params it always did.

import { redirect } from "next/navigation";

import { buildPadronHubRedirectUrl } from "@/lib/ui/padron-hub-redirect";

export default async function GobCensoRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  redirect(buildPadronHubRedirectUrl(sp, "censo"));
}
