// /gob/disputas — ABSORBED into the Casos hub as the "Disputas" expediente
// (F6 fusion, 2026-07-22: PO-approved route unification — the expediente
// family, same legal-administrative operator, identical case-file grammar).
// This route now only redirects, preserving every query param (status),
// into /gob/casos?expediente=disputas.
//
// The actual queue lives in ./DisputasScreen.tsx (byte-identical body of the
// former page), imported and rendered by app/gob/casos/page.tsx under the
// "disputas" tab. /gob/disputas/[disputeToken] is UNCHANGED — nested detail
// routes don't move.

import { redirect } from "next/navigation";

import { buildCasosHubRedirectUrl } from "@/lib/ui/casos-hub-redirect";

export default async function GobDisputasRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  redirect(buildCasosHubRedirectUrl(sp, "disputas"));
}
