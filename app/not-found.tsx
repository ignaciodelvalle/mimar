import { BrandedNotFound } from "@/components/BrandedNotFound";

// CSP × PRERENDER (external design review C3-P1 / X1-F2).
//
// The middleware mints a per-request CSP nonce and the policy carries
// `'strict-dynamic'`, which makes the browser IGNORE `'self'` for scripts and
// execute ONLY what is nonce'd. A prerendered page's HTML is written at build
// time with no nonce at all, so in production 100% of its JavaScript is
// refused: the page renders (SSR markup) and arrives dead — no hydration, no
// error boundaries, a wall of red in the console.
//
// force-dynamic takes this route out of the prerender set so Next stamps the
// request's nonce into its <script> tags. Verified against the build output:
// `.next/server/app/*.html` must stay empty.
export const dynamic = "force-dynamic";

// ROOT not-found — catches ALL unmatched URLs app-wide (e.g. /admin/zzz,
// /gob/zzz, /foo). Next renders THIS for an unmatched route; a nested
// not-found.tsx only catches an explicit notFound() thrown within its segment.
// Without this root file, unmatched URLs fell to Next's black English default
// ("This page could not be found"). Admin fresh-sweep A1 / dashboards deep-dive D7.
// The <main id="main-content"> lives HERE and not inside BrandedNotFound.
//
// app/layout.tsx renders the "Ir al contenido principal" skip link on every
// page, unconditionally, pointing at #main-content. This is the ONE not-found
// that renders with no shell above it — an unmatched URL bypasses the route
// groups entirely (see the note above) — so the link had no target and the page
// had no main landmark at all (adversarial review 2026-08-08, S6-F05).
//
// The other four not-found.tsx files ((app), admin, gob, (public)) only catch an
// explicit notFound() inside their segment, so they render INSIDE their group's
// AppShell, which already owns the single #main-content. Putting the landmark
// in the shared component would give those four a duplicate <main> and a
// duplicate id — the exact defect AppShell.landing.test.tsx guards against.
export default function RootNotFound() {
  return (
    <main id="main-content">
      <BrandedNotFound
        title="No encontramos esta página"
        // Los sustantivos estaban intercambiados contra las otras tres 404 del
        // producto ((app), gob y admin dicen "La página … Revisá la dirección").
        // Tres de cuatro coincidían; ésta era la que se salía.
        body="La página que buscás no existe o cambió de lugar. Revisá la dirección o volvé al inicio."
        primary={{ href: "/", label: "Volver al inicio" }}
      />
    </main>
  );
}
