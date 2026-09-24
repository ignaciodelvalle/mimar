// Org index page — entry point for the org portal. If the user has exactly
// one active org membership they are auto-redirected to that org's dashboard.
// If they have multiple memberships they see a picker. If they have none they
// see an empty state with guidance.
//
// This replaces the old "active org inferred from session" model. The orgToken
// from the URL segment is now the only source of truth — see AGENTS.md and
// docs/superpowers/plans/2026-05-17-code-rename-refugio-to-org.md for context.

import { OpPill } from "@/components/ui/dashboard/OpPill";
import { db, organizationMemberships, organizations } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { BRANDING } from "@/lib/ui/branding";
import { and, eq, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

// PO quick win V2 (2026-07-24): matches the fuller es-AR label set already
// used for approval-request display (lib/infra/approval-payload-summary.ts) —
// "Clínica" alone read as ambiguous when read next to "Refugio"/"Red de
// rescate" on the picker.
const ORG_TYPE_LABELS: Record<string, string> = {
  clinic: "Clínica veterinaria",
  shelter: "Refugio",
  rescue_network: "Red de rescate",
  sanitary_authority: "Autoridad sanitaria",
  other: "Otra",
};

// PO quick win V2 (2026-07-24): the cookie middleware.ts stamps on every
// /org/[orgToken]/* request — a UX preference only (see middleware.ts's
// comment), re-validated here against the caller's OWN membership list.
const LAST_ORG_COOKIE = "dim_last_org";

// miMAR brand header for the standalone org index (#43 item 5). The picker and
// empty state render outside the org rail, so they carried no brand — a member
// of several orgs landed on an unbranded "Seleccionar organización" screen.
// Mirrors the OpRail monogram + serif wordmark, tuned for the light op page.
function MiMarBrandHeader({ subtitle }: { subtitle: string }) {
  return (
    <div className="flex items-center gap-2.5">
      {/* Same mark as the citizen masthead and the operator rail/drawer
          (components/layout/AppCitizenMasthead.tsx) — was a typographic `m·`
          monogram, INVERTED (white text on a navy tile). No paper tile here:
          unlike those navy surfaces, this page's own ground is bg-ln-op-page
          (#eef1f4, light — app/globals.css) and the mark's currentColor
          default IS --color-ln-op-azul (#0e5a99), the exact blue this page
          already uses for its own text link (the /cuenta/upgrade link in the
          empty state below) — plenty of contrast directly on the light
          ground, so a tile would only be a redundant light-on-light square.
          alt="" because the wordmark + subtitle beside it already carry the
          brand name. */}
      <img src="/logo-mimar-mark.svg" alt="" width={34} height={34} className="flex-shrink-0" />
      <div className="flex flex-col leading-tight">
        <span className="font-ln-serif text-base font-semibold tracking-[-0.005em] text-ln-op-ink">
          {BRANDING.appName}
        </span>
        <span className="text-xs font-semibold uppercase tracking-[0.2em] text-ln-op-mute">
          {subtitle}
        </span>
      </div>
    </div>
  );
}

export default async function OrgIndexPage() {
  const { user } = await requireUserOrRedirect();

  const myOrgs = await db
    .select({
      org: organizations,
      membership: organizationMemberships,
    })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(
      and(eq(organizationMemberships.userId, user.id), isNull(organizationMemberships.leftAt)),
    );

  if (myOrgs.length === 0) {
    return (
      <main className="min-h-screen bg-ln-op-page flex flex-col items-center justify-center p-6">
        <div className="mb-8">
          <MiMarBrandHeader subtitle="Portal de organizaciones" />
        </div>
        <div className="max-w-md text-center space-y-3">
          <h1 className="text-title font-semibold text-ln-op-ink">Sin organizaciones</h1>
          <p className="text-md text-ln-op-mute">
            No sos miembro activo de ninguna organización. Si tu organización te invitó, revisá tu
            email para aceptar la invitación. Si querés registrar una nueva, andá a{" "}
            <Link href="/cuenta/upgrade" className="underline text-ln-op-azul">
              /cuenta/upgrade
            </Link>
            .
          </p>
          <Link
            href="/mis-mascotas"
            className="inline-block px-4 py-2 rounded-[var(--radius-md)] bg-ln-op-azul text-white text-md font-medium"
          >
            Volver a mis mascotas
          </Link>
        </div>
      </main>
    );
  }

  if (myOrgs.length === 1) {
    // Single membership — auto-redirect to that org's dashboard.
    redirect(`/org/${myOrgs[0].org.publicToken}`);
  }

  // PO quick win V2 (2026-07-24): sort the last-used org first — re-validated
  // against THIS caller's own already-fetched membership list (no new query;
  // a stale/foreign cookie just fails to match and the list renders in its
  // original order). Never auto-redirects: a multi-org member switching
  // between orgs would be surprised by a silent jump away from the picker.
  const lastOrgToken = (await cookies()).get(LAST_ORG_COOKIE)?.value;
  const lastUsedIndex = lastOrgToken
    ? myOrgs.findIndex(({ org }) => org.publicToken === lastOrgToken)
    : -1;
  const sortedOrgs =
    lastUsedIndex > 0
      ? [
          myOrgs[lastUsedIndex],
          ...myOrgs.slice(0, lastUsedIndex),
          ...myOrgs.slice(lastUsedIndex + 1),
        ]
      : myOrgs;

  // Multiple memberships — render a picker so the user can choose.
  return (
    <main className="min-h-screen bg-ln-op-page p-6">
      <div className="max-w-2xl mx-auto pt-8 space-y-6">
        <MiMarBrandHeader subtitle="Portal de organizaciones" />
        <header className="space-y-2">
          <h1 className="text-title font-semibold text-ln-op-ink">Seleccionar organización</h1>
          <p className="text-md text-ln-op-mute">
            Pertenecés a {myOrgs.length} organizaciones. Elegí con cuál querés trabajar.
          </p>
        </header>
        <ul className="space-y-3">
          {sortedOrgs.map(({ org, membership }) => (
            <li key={org.id}>
              <Link
                href={`/org/${org.publicToken}`}
                className="block p-4 rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card hover:bg-ln-op-stripe transition-colors no-underline"
              >
                <div className="flex items-center gap-2">
                  <p className="text-md font-semibold text-ln-op-ink">{org.displayName}</p>
                  {org.publicToken === lastOrgToken && <OpPill tone="neutral">Última usada</OpPill>}
                </div>
                <p className="text-sm text-ln-op-mute mt-0.5">
                  {ORG_TYPE_LABELS[org.orgType] ?? org.orgType}
                  {org.jurisdictionLocality ? ` · ${org.jurisdictionLocality}` : ""}
                  {" · "}
                  {membership.role}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
