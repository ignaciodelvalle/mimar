// /gob/moderacion — ABSORBED into the Denuncias hub as the "Moderación"
// stage (F1 fusion, 2026-07-22: PO-approved route unification — same worker,
// same daily moment, same decision family). This route now only redirects,
// preserving every query param, into /gob/denuncias?etapa=moderacion.
//
// The actual queue lives in ./ModeracionQueueScreen.tsx (byte-identical body
// of the former page), imported and rendered by app/gob/denuncias/page.tsx
// under the "moderacion" tab. /gob/moderacion/[id] is UNCHANGED — nested
// detail routes don't move.

import { redirect } from "next/navigation";

import { buildDenunciasHubRedirectUrl } from "@/lib/ui/denuncias-hub-redirect";

export default async function GobModeracionRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  redirect(buildDenunciasHubRedirectUrl(sp, "moderacion"));
}
