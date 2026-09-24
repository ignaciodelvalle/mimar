// /gob/analitica — bug fix (qa-triage-2026-07-23, finding #11): the route the
// nav used to expose was /gob/analytics, but nothing caught the honest human
// typo "analitica" — it 404'd.
//
// F9 fusion (2026-08-01): Analítica is now the Programa hub's second vista, so
// this alias redirects STRAIGHT to /gob/programa?vista=analitica. It
// deliberately does NOT chain through /gob/analytics (which is itself a
// redirect now): two permanent redirects for one mistyped letter is a hop the
// visitor never has to pay for, and a redirect chain is the kind of thing that
// silently becomes a loop the day someone re-points one of its links.

import { redirect } from "next/navigation";

import { buildProgramaHubRedirectUrl } from "@/lib/ui/programa-hub-redirect";

export default async function GobAnaliticaRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  redirect(buildProgramaHubRedirectUrl(sp, "analitica"));
}
