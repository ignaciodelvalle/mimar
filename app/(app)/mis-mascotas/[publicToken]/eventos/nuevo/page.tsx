// Permanent redirect — /mis-mascotas/[publicToken]/eventos/nuevo was a second
// event catalog that duplicated /anotar. Pet profile v2.1 (Item 6, spec §3.3,
// D7) collapses the action hubs: /anotar is the single canonical capture
// surface, so this catalog index now 308-redirects there. Bookmarks and old
// links keep working — same pattern as /libreta, /historial, /vacunas.
//
// IMPORTANT: only the catalog INDEX redirects. The form sub-routes under
// eventos/nuevo/* (vacuna, embarazo, microchip, …) are the actual event forms
// and remain the public-contract targets of lib/event-capture-registry.ts,
// lib/event-capture-matcher.ts and lib/notifications.ts — they are untouched.
//
// Forwarded query params (e.g. ?text=…&kind=…) are preserved on the redirect
// so a deep link that landed here still hands off cleanly to /anotar.

import { permanentRedirect } from "next/navigation";

export default async function PickEventPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicToken: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { publicToken } = await params;
  const sp = await searchParams;

  // Preserve any forwarded query params (string values only; arrays use the
  // first entry — these params are single-valued by contract).
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === "string") {
      qs.set(key, value);
    } else if (Array.isArray(value) && typeof value[0] === "string") {
      qs.set(key, value[0]);
    }
  }

  const query = qs.toString();
  const target = `/mis-mascotas/${publicToken}/anotar${query ? `?${query}` : ""}`;
  permanentRedirect(target);
}
