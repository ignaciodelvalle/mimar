// Permanent redirect: /login → /iniciar-sesion.
//
// The canonical auth routes moved to Spanish (QA 2026-08-08, S1-F06). They were
// the ONLY two user-facing routes in the product still in English, against the
// project's own invariant — "Spanish (es-AR) UI, English code" — and a URL is
// user-facing surface, not a code identifier.
//
// This stub stays FOREVER, not as a migration step. The old English path is
// printed in docs, sitting in browser bookmarks, and pasted into any number of
// messages and emails already sent. A 308 keeps every one of them working, and
// keeps each of the ~30 internal references that were swept alongside it from
// being a correctness risk if one was missed.
//
// The query string is preserved verbatim: `intent` and `returnTo` carry the
// whole point of a login round-trip (apply / foster / a deep link the visitor
// was bounced out of), and dropping them would strand exactly the user who had
// somewhere to go back to.

import { permanentRedirect } from "next/navigation";

export default async function LoginRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === "string") qs.set(key, value);
    else if (Array.isArray(value)) for (const v of value) qs.append(key, v);
  }
  const query = qs.toString();
  permanentRedirect(query ? `/iniciar-sesion?${query}` : "/iniciar-sesion");
}
