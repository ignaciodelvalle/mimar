// Mis organizaciones — Libreta Nacional redesign.
// Data fetching unchanged.

import { and, count, eq, inArray, isNull } from "drizzle-orm";
import Link from "next/link";

import { LnEmptyState } from "@/components/ui/EmptyState";
import { db, organizationMemberships } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { formatDate } from "@/lib/utils/format";
import { getActiveMemberships } from "@/src/modules/organizations/infrastructure/authz-resolver";

import { LeaveMembershipButton } from "./LeaveMembershipButton";

const ORG_TYPE_LABELS: Record<string, string> = {
  clinic: "Clínica",
  shelter: "Refugio",
  rescue_network: "Red de rescate",
  sanitary_authority: "Autoridad sanitaria",
  other: "Organización",
};

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrador/a",
  coordinator: "Coordinador/a",
  member: "Miembro",
  volunteer: "Voluntario/a",
  foster: "Transitante",
  vet_individual: "Veterinario/a individual",
};

export default async function MembershipsPage() {
  const { user } = await requireUserOrRedirect();
  const memberships = await getActiveMemberships(user.id);
  const membershipCount = memberships.length;

  // Active-admin count per org where the user is admin — leaveOrganizationAction
  // blocks the last admin, so the button is disabled upfront with an explanation.
  const adminOrgIds = memberships
    .filter(({ membership }) => membership.role === "admin")
    .map(({ organization }) => organization.id);
  const adminCounts =
    adminOrgIds.length > 0
      ? await db
          .select({ organizationId: organizationMemberships.organizationId, n: count() })
          .from(organizationMemberships)
          .where(
            and(
              inArray(organizationMemberships.organizationId, adminOrgIds),
              eq(organizationMemberships.role, "admin"),
              isNull(organizationMemberships.leftAt),
            ),
          )
          .groupBy(organizationMemberships.organizationId)
      : [];
  const adminCountByOrg = new Map(adminCounts.map((r) => [r.organizationId, Number(r.n)]));

  return (
    <div className="mx-auto max-w-2xl px-8 py-7 pb-12">
      {/* Back */}
      <Link
        href="/cuenta"
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← Mi cuenta
      </Link>

      {/* Header */}
      <div className="mb-7 flex items-baseline gap-3.5">
        <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
          Mis organizaciones
        </h1>
        <span className="font-ln-mono text-sm text-[var(--color-ln-mute)]">
          {membershipCount === 0
            ? "ninguna"
            : membershipCount === 1
              ? "1 membresía"
              : `${membershipCount} membresías`}
        </span>
      </div>

      {/* Empty state */}
      {membershipCount === 0 && (
        <LnEmptyState
          variant="dashed"
          title="No tenés membresías de ninguna organización todavía."
          description="Si querés crear una clínica, refugio o red de rescate, pasate a veterinario/a desde tu cuenta."
          action={
            <Link
              href="/cuenta/upgrade"
              className="text-[var(--color-ln-azul)] no-underline hover:underline"
            >
              Pasate a veterinario/a
            </Link>
          }
        />
      )}

      {/* Memberships list */}
      {membershipCount > 0 && (
        <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]">
          {memberships.map(({ membership, organization }) => {
            const isLastAdmin =
              membership.role === "admin" && (adminCountByOrg.get(organization.id) ?? 0) <= 1;
            return (
              <div
                key={membership.id}
                className="flex items-center justify-between gap-4 border-b border-[var(--color-ln-line-2)] px-[18px] py-3.5 last:border-b-0"
              >
                <Link
                  href={`/org/${organization.publicToken}`}
                  className="group min-w-0 flex-1 no-underline"
                >
                  <p className="font-ln-serif text-base font-semibold leading-tight text-[var(--color-ln-ink)] truncate group-hover:underline">
                    {organization.displayName}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <OrgTypeBadge orgType={organization.orgType} />
                    <VerifiedBadge verified={organization.verified} />
                    <RoleBadge role={membership.role} />
                  </div>
                  <p className="mt-[5px] font-ln-mono text-sm text-[var(--color-ln-mute)]">
                    Desde {formatDate(membership.joinedAt)}
                  </p>
                </Link>
                <div className="flex-shrink-0">
                  <LeaveMembershipButton
                    organizationId={organization.id}
                    isLastAdmin={isLastAdmin}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function OrgTypeBadge({ orgType }: { orgType: string }) {
  const label = ORG_TYPE_LABELS[orgType] ?? orgType;
  return (
    <span className="inline-flex items-center rounded-[var(--radius-xs)] border border-[var(--color-ln-celeste-100)] bg-[var(--color-ln-celeste-050)] px-[7px] py-0.5 font-ln-mono text-xs uppercase tracking-[.1em] text-[var(--color-ln-azul)]">
      {label}
    </span>
  );
}

function VerifiedBadge({ verified }: { verified: boolean }) {
  if (verified) {
    return (
      <span className="inline-flex items-center rounded-[var(--radius-xs)] border border-[var(--color-ln-ok-100)] bg-[var(--color-ln-ok-050)] px-[7px] py-0.5 font-ln-mono text-xs uppercase tracking-[.1em] text-[var(--color-ln-ok)]">
        Verificada
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-[var(--radius-xs)] border border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-050)] px-[7px] py-0.5 font-ln-mono text-xs uppercase tracking-[.1em] text-[var(--color-ln-warn)]">
      Pendiente
    </span>
  );
}

function RoleBadge({ role }: { role: string }) {
  const label = ROLE_LABELS[role] ?? role;
  return (
    <span className="inline-flex items-center rounded-[var(--radius-xs)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-stripe)] px-[7px] py-0.5 font-ln-mono text-xs uppercase tracking-[.1em] text-[var(--color-ln-mute)]">
      {label}
    </span>
  );
}
