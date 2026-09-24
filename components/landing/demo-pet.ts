// The landing hero's demo credential is DEMO FURNITURE — and must declare it.
//
// WHY THIS FILE EXISTS (cold-start review RA-6, finding 1)
// ---------------------------------------------------------------------------
// The hero renders a REAL, scannable QR pointing at /p/{token}, and
// app/(public)/p/[publicToken]/page.tsx calls notFound() when the token does
// not resolve. The token used to be a hardcoded constant in landing-content.ts
// ("the flagship pet"), seeded by scripts/seed-flagship-pampa.ts — a script
// that runs in NEITHER scripts/db-bootstrap.ts step 4 NOR
// scripts/deploy-provision.ts step 8. dim-interno:docs/ops/cutover-playbook.md then
// mandates production be loaded with "no seed pets, no demo accounts".
//
// So the front door of a government product shipped a QR that scans to a 404
// on every honestly-provisioned deployment. A QR that scans to a 404 is worse
// than no QR: the funcionario's first impression is a broken credential.
//
// THE CONTRACT
// ---------------------------------------------------------------------------
// A deployment that HAS demo furniture says so, per-deployment, via the
// DEMO_PET_TOKEN environment variable. This is the same doctrine the seed
// precondition contract already enforces for tests (PO decision D2, see
// __tests__/seed-precondition-contract.test.ts): a dependency on seeded rows
// is DECLARED, never assumed, and never satisfied by teaching bootstrap to
// build demo furniture.
//
//   - unset / empty  → production. The hero renders an illustrative credential
//                      with no scannable QR and no link. It promises nothing.
//   - set + resolves → staging/demo. The hero renders the real scannable QR.
//   - set + missing  → typo or a re-seeded database. app/page.tsx probes the
//                      row before generating the QR, so this degrades exactly
//                      like the unset case instead of shipping a 404 QR.
//
// Server-only on purpose (NOT NEXT_PUBLIC_): only app/page.tsx reads it, and a
// build-time-inlined public var would bake a stale token into the client
// bundle. Import this from server components only.
//
// TO TURN THE HERO QR ON for a demo deployment (e.g. dim-staging), seed the
// flagship and declare it:
//
//   pnpm tsx scripts/seed-flagship-pampa.ts
//   DEMO_PET_TOKEN=DIM-PAMP-0001            # .env.local, or `vercel env add`
//
// Reads with .trim() and a truthiness fallback, not `??`: `vercel env` can set
// a variable to the empty string (set, not unset), and `??` does not catch
// that — the same set-but-empty pitfall lib/infra/site-url.ts documents, which
// already produced one real landing-hero QR bug.

/**
 * Public token of this deployment's demo pet, or null when the deployment has
 * declared no demo furniture. Callers MUST handle null by degrading — never by
 * substituting a default token.
 */
export function resolveDemoPetToken(): string | null {
  return (process.env.DEMO_PET_TOKEN ?? "").trim() || null;
}
