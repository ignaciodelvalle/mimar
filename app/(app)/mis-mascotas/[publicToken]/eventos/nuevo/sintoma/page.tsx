/**
 * Direct-navigation handler for /eventos/nuevo/sintoma.
 *
 * This form is sheet-first: it is normally reached via the SheetMounter
 * sheet "?sheet=sintoma" on the pet profile page. There is no standalone
 * full-page form at this path — navigating here directly (e.g. from a
 * bookmark or a shared URL) would otherwise 404.
 *
 * Strategy: redirect to the parent pet-profile page with the correct
 * ?sheet= param so the sheet opens automatically. Any prefill slots
 * declared in the event-capture-registry (freeText, onsetAt) are forwarded
 * as-is so captura-rápida deeplinks continue to work.
 *
 * Sheet ID: "sintoma" (matches SheetMounter's `if (sheet === "sintoma")` branch).
 */

import { redirect } from "next/navigation";

export default async function SintomaRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicToken: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { publicToken } = await params;
  const sp = await searchParams;

  // Forward prefill slots declared in the registry for symptom_observed.
  const forwarded = new URLSearchParams();
  forwarded.set("sheet", "sintoma");
  if (sp.freeText) forwarded.set("freeText", sp.freeText);
  if (sp.onsetAt) forwarded.set("onsetAt", sp.onsetAt);

  redirect(`/mis-mascotas/${publicToken}?${forwarded.toString()}`);
}
