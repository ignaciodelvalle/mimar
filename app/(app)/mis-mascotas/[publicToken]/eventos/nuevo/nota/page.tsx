/**
 * Direct-navigation handler for /eventos/nuevo/nota.
 *
 * This form is sheet-first: it is normally reached via the SheetMounter
 * sheet "?sheet=nota" on the pet profile page. There is no standalone
 * full-page form at this path — navigating here directly (e.g. from a
 * bookmark or a shared URL) would otherwise 404.
 *
 * Strategy: redirect to the parent pet-profile page with the correct
 * ?sheet= param so the sheet opens automatically. Any prefill slots
 * declared in the event-capture-registry (text, occurredAt) are forwarded
 * as-is so captura-rápida deeplinks continue to work.
 *
 * Sheet ID: "nota" (matches SheetMounter's `if (sheet === "nota")` branch).
 */

import { redirect } from "next/navigation";

export default async function NotaRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicToken: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { publicToken } = await params;
  const sp = await searchParams;

  // Forward prefill slots declared in the registry for note_added.
  const forwarded = new URLSearchParams();
  forwarded.set("sheet", "nota");
  if (sp.text) forwarded.set("text", sp.text);
  if (sp.occurredAt) forwarded.set("occurredAt", sp.occurredAt);

  redirect(`/mis-mascotas/${publicToken}?${forwarded.toString()}`);
}
