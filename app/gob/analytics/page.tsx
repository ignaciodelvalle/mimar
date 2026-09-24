// /gob/analytics — ABSORBED into the Programa hub as the "Analítica" vista
// (F9 fusion, 2026-08-01: PO decision on an external-QA navigation gate — the
// briefing alerts said "Ver en Programa →" and landed on /gob/programa while
// four KPI tiles landed here on a screen titled "Analítica". Two destinations,
// one noun; the fold removes the ambiguity).
//
// This route now only redirects, preserving every query param (period/from/
// to/province/locality), into /gob/programa?vista=analitica.
//
// The actual dashboard lives in ./AnalyticsScreen.tsx (byte-identical body of
// the former page), imported and rendered by app/gob/programa/page.tsx under
// the "analitica" tab. ./export is UNCHANGED — it is a child form route with
// its own searchParams contract, not a view of this dashboard.

import { redirect } from "next/navigation";

import { buildProgramaHubRedirectUrl } from "@/lib/ui/programa-hub-redirect";

export default async function GobAnalyticsRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  redirect(buildProgramaHubRedirectUrl(sp, "analitica"));
}
