// /gob/poblacion — ABSORBED into the Padrón hub as the "Población" vista
// (F8 fusion, 2026-07-22: PO-approved route unification — both are
// registry-derived Programa surfaces the registry manager reads together).
// This route now only redirects, preserving every query param (period/from/
// to/province/locality/species), into /gob/padron?vista=poblacion.
//
// The actual dashboard lives in ./PoblacionScreen.tsx (byte-identical body
// of the former page), imported and rendered by app/gob/padron/page.tsx
// under the "poblacion" tab (the default). /gob/poblacion/export is
// UNCHANGED — it's an API route, not a page, and keeps reading the same
// query params it always did.

import { redirect } from "next/navigation";

import { buildPadronHubRedirectUrl } from "@/lib/ui/padron-hub-redirect";

export default async function GobPoblacionRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  redirect(buildPadronHubRedirectUrl(sp, "poblacion"));
}
