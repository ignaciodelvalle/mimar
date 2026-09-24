// /gob/maltrato — ABSORBED into the Denuncias hub as the "Triage (Ley
// 14.346)" stage (F1 fusion, 2026-07-22: PO-approved route unification —
// same worker, same daily moment, same decision family). This route now
// only redirects, preserving every query param (including the inspector's
// ?caso=/&mascota=/&panel= deep-link params and the ?queue= workqueue tabs),
// into /gob/denuncias?etapa=triage.
//
// The actual queue lives in ./MaltratoQueueScreen.tsx (byte-identical body of
// the former page), imported and rendered by app/gob/denuncias/page.tsx
// under the "triage" tab. /gob/maltrato/[id] is UNCHANGED — nested detail
// routes don't move.

import { redirect } from "next/navigation";

import { buildDenunciasHubRedirectUrl } from "@/lib/ui/denuncias-hub-redirect";

export default async function GobMaltratoRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  redirect(buildDenunciasHubRedirectUrl(sp, "triage"));
}
