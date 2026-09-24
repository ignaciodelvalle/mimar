/**
 * Direct-navigation handler for /eventos/nuevo/peso.
 *
 * This form is sheet-first: it is normally reached via the SheetMounter
 * sheet "?sheet=peso" on the pet profile page. There is no standalone
 * full-page form at this path — navigating here directly (e.g. from a
 * bookmark or a shared URL) would otherwise 404.
 *
 * Strategy: redirect to the parent pet-profile page with the correct
 * ?sheet= param so the sheet opens automatically. Any prefill slots
 * declared in the event-capture-registry (kg, occurredAt, notes) are
 * forwarded as-is so captura-rápida deeplinks continue to work.
 *
 * Sheet ID: "peso" (matches SheetMounter's `if (sheet === "peso")` branch).
 */

import { redirect } from "next/navigation";

export default async function PesoRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicToken: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { publicToken } = await params;
  const sp = await searchParams;

  // Forward prefill slots declared in the registry for weight_recorded.
  const forwarded = new URLSearchParams();
  forwarded.set("sheet", "peso");
  if (sp.kg) forwarded.set("kg", sp.kg);
  if (sp.occurredAt) forwarded.set("occurredAt", sp.occurredAt);
  if (sp.notes) forwarded.set("notes", sp.notes);

  redirect(`/mis-mascotas/${publicToken}?${forwarded.toString()}`);
}
