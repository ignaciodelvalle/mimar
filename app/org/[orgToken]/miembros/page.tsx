// Org members page — active member list + pending invitations.
// Invitations and revoke controls are shown only to users holding member.invite.
// Management controls (role change, event-write toggle, remove) are shown
// when the viewer holds member.invite AND the rank rule permits managing that target.

import { deepLinkUrl } from "@dim/contract/links";
import { and, count, desc, eq, gt, isNull } from "drizzle-orm";
import Link from "next/link";

import { OpCard, OpCardBody, OpPill } from "@/components/ui/dashboard";
import {
  db,
  organizationCapabilityGrants,
  organizationInvitations,
  organizationMemberships,
  profiles,
} from "@/db";
import type { OrganizationMembership } from "@/db";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { resolveSiteUrl } from "@/lib/infra/site-url";
import { formatDate } from "@/lib/utils/format";
// Aliased — this file already has a local `capRows` (capability grant rows).
import { capRows as capListRows } from "@/lib/utils/list-pagination";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";

import { ChangeRoleSelect } from "./ChangeRoleSelect";
import { CopyLinkButton } from "./CopyLinkButton";
import { EventWriteToggle } from "./EventWriteToggle";
import { LeaveOrgButton } from "./LeaveOrgButton";
import { RemoveMemberButton } from "./RemoveMemberButton";
import { RevokeButton } from "./RevokeButton";
import { ROLE_LABEL, canActorManage, getSettableRoles } from "./member-management";

const ROLE_PILL_TONE: Record<
  OrganizationMembership["role"],
  "triaged" | "ok" | "neutral" | "open"
> = {
  admin: "triaged",
  coordinator: "ok",
  member: "neutral",
  volunteer: "neutral",
  vet_individual: "open",
  foster: "neutral",
};

export default async function MiembrosPage({
  params,
}: {
  params: Promise<{ orgToken: string }>;
}) {
  const { orgToken } = await params;
  const { organization, membership } = await requireOrgAccessByToken(orgToken);

  const granted = await getGrantedCapabilities(membership);
  const canInvite = granted.has("member.invite");

  // Active members joined with their profiles.
  //
  // #815 audit finding #5: previously had no .limit()/.offset() at all — a
  // large network or rescue coalition could return a genuinely unbounded
  // list. Fetch one extra row past the cap (same fetch-N+1 pattern as
  // adopciones/page.tsx) so a truncated notice appears instead of silently
  // rendering everything.
  const MEMBERS_PAGE_SIZE = 200;
  const memberRows = await db
    .select({
      membership: organizationMemberships,
      profile: profiles,
    })
    .from(organizationMemberships)
    .innerJoin(profiles, eq(profiles.id, organizationMemberships.userId))
    .where(
      and(
        eq(organizationMemberships.organizationId, organization.id),
        isNull(organizationMemberships.leftAt),
      ),
    )
    .orderBy(desc(organizationMemberships.joinedAt))
    .limit(MEMBERS_PAGE_SIZE + 1);

  const { rows: members, truncated: membersTruncated } = capListRows(memberRows, MEMBERS_PAGE_SIZE);

  // Resolve which memberships have an active `event.write` capability grant.
  // This is the authoritative enforcement state — the legacy canWritePetEvents
  // column is deprecated (mirrors only; not used here for display).
  //
  // We fetch all approved `event.write` grants for this org in one query.
  // Admin and vet_individual have `event.write` implicitly (resolveGrantedCaps)
  // and are treated as always having it regardless of explicit grant rows.
  const eventWriteSet = new Set<string>(); // membershipId → has event.write capability
  const capRows = await db
    .select({ membershipId: organizationCapabilityGrants.membershipId })
    .from(organizationCapabilityGrants)
    .where(
      and(
        eq(organizationCapabilityGrants.organizationId, organization.id),
        eq(organizationCapabilityGrants.capability, "event.write"),
        eq(organizationCapabilityGrants.status, "approved"),
      ),
    );
  for (const r of capRows) eventWriteSet.add(r.membershipId);
  // Admin and vet_individual have event.write implicitly (resolveGrantedCaps).
  for (const m of members) {
    if (m.membership.role === "admin" || m.membership.role === "vet_individual") {
      eventWriteSet.add(m.membership.id);
    }
  }

  // Count active admins — needed to determine isLastAdmin for the self-leave button.
  const [adminCountRow] = await db
    .select({ n: count() })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organization.id),
        isNull(organizationMemberships.leftAt),
        eq(organizationMemberships.role, "admin"),
      ),
    );
  const activeAdminCount = Number(adminCountRow?.n ?? 0);
  const viewerIsLastAdmin = membership.role === "admin" && activeAdminCount <= 1;

  // True total (unaffected by the MEMBERS_PAGE_SIZE cap above) — used for the
  // section heading so it doesn't silently read "200" for a 300-member org.
  const [totalMembersRow] = await db
    .select({ n: count() })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organization.id),
        isNull(organizationMemberships.leftAt),
      ),
    );
  const totalMembersCount = Number(totalMembersRow?.n ?? members.length);

  // Settable roles for the viewer (rank-bounded).
  const settableRoles = canInvite ? getSettableRoles(membership.role) : [];

  // Pending invitations: not accepted, not revoked, not yet expired.
  // Only fetched when the viewer holds member.invite (avoids leaking invite
  // details to members who can't manage them).
  const now = new Date();
  const pendingInvitations = canInvite
    ? await db
        .select()
        .from(organizationInvitations)
        .where(
          and(
            eq(organizationInvitations.organizationId, organization.id),
            isNull(organizationInvitations.acceptedAt),
            isNull(organizationInvitations.revokedAt),
            gt(organizationInvitations.expiresAt, now),
          ),
        )
    : [];

  const appBase = resolveSiteUrl();

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          {/* Identity marker standardized to the org-name eyebrow (audit #13),
              so every Administración page marks tenancy the same way. H1 matches
              the nav label "Miembros" (audit #17 — nav↔H1 parity). */}
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
            {organization.displayName}
          </p>
          <h1 className="text-title font-semibold text-ln-op-ink">Miembros</h1>
        </div>
        {canInvite && (
          <Link
            href={`/org/${orgToken}/miembros/invitar`}
            className="inline-flex shrink-0 items-center gap-2 rounded-[var(--radius-md)] bg-ln-op-azul px-4 py-[7px] text-sm font-semibold text-white transition-colors hover:bg-ln-op-azul-700 no-underline"
          >
            Invitar miembro
          </Link>
        )}
      </header>

      {/* Active members */}
      <section aria-labelledby="members-heading">
        <h2
          id="members-heading"
          className="mb-3 text-md font-semibold uppercase tracking-[0.08em] text-ln-op-mute"
        >
          Miembros activos ({totalMembersCount})
        </h2>
        {membersTruncated && (
          <p className="mb-3 text-sm text-ln-op-mute">
            Mostrando los primeros {MEMBERS_PAGE_SIZE} de {totalMembersCount}.
          </p>
        )}
        {members.length === 0 ? (
          <OpCard>
            <OpCardBody>
              <p className="py-6 text-center text-md text-ln-op-mute">
                Aún no hay miembros registrados en esta organización.
              </p>
            </OpCardBody>
          </OpCard>
        ) : (
          <OpCard>
            <ul className="divide-y divide-ln-op-line">
              {members.map(({ membership: m, profile }) => {
                const isSelf = m.userId === membership.userId;
                // Foster members are managed via the foster flow, not this path.
                const isFoster = m.role === "foster";
                const canManage =
                  canInvite && !isSelf && !isFoster && canActorManage(membership.role, m.role);

                return (
                  <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-md font-medium text-ln-op-ink">
                        {profile.displayName}
                        {isSelf && (
                          <span className="ml-2 text-sm font-normal text-ln-op-mute">(vos)</span>
                        )}
                      </p>
                      {m.title && <p className="truncate text-sm text-ln-op-mute">{m.title}</p>}
                    </div>

                    {/* Role pill — replaced by selector when actor can manage (never for foster) */}
                    {canManage ? (
                      <ChangeRoleSelect
                        organizationId={organization.id}
                        membershipId={m.id}
                        currentRole={m.role}
                        settableRoles={settableRoles}
                      />
                    ) : (
                      <div className="flex flex-col items-end gap-0.5">
                        <OpPill tone={ROLE_PILL_TONE[m.role]}>{ROLE_LABEL[m.role]}</OpPill>
                        {isFoster && canInvite && (
                          <span className="text-sm text-ln-op-mute">Gestionado vía tránsito</span>
                        )}
                      </div>
                    )}

                    {/* Event-write toggle and remove — only for manageable targets */}
                    {canManage && (
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <EventWriteToggle
                          organizationId={organization.id}
                          membershipId={m.id}
                          canWrite={eventWriteSet.has(m.id)}
                        />
                        <RemoveMemberButton
                          organizationId={organization.id}
                          membershipId={m.id}
                          displayName={profile.displayName}
                        />
                      </div>
                    )}

                    {/* Self row: show leave button instead of management controls */}
                    {isSelf && (
                      <LeaveOrgButton
                        organizationId={organization.id}
                        isLastAdmin={viewerIsLastAdmin}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </OpCard>
        )}
      </section>

      {/* Pending invitations — visible only to users with member.invite */}
      {canInvite && (
        <section aria-labelledby="invitations-heading">
          <h2
            id="invitations-heading"
            className="mb-3 text-md font-semibold uppercase tracking-[0.08em] text-ln-op-mute"
          >
            Invitaciones pendientes ({pendingInvitations.length})
          </h2>
          {pendingInvitations.length === 0 ? (
            <OpCard>
              <OpCardBody>
                <p className="py-6 text-center text-md text-ln-op-mute">
                  Invitá a alguien con el botón de arriba.
                </p>
              </OpCardBody>
            </OpCard>
          ) : (
            <OpCard>
              <ul className="divide-y divide-ln-op-line">
                {pendingInvitations.map((inv) => {
                  // From the deep-link table: this url is copied out of the app
                  // and pasted into an e-mail or a chat, so it outlives every
                  // deploy between now and whenever the invitee opens it.
                  const inviteUrl = deepLinkUrl(appBase, "orgInvitation", {
                    invitationToken: inv.invitationToken,
                  });
                  return (
                    <li key={inv.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-md font-medium text-ln-op-ink">{inv.email}</p>
                        <p className="text-sm text-ln-op-mute">Vence {formatDate(inv.expiresAt)}</p>
                      </div>
                      <OpPill tone={ROLE_PILL_TONE[inv.invitedRole]}>
                        {ROLE_LABEL[inv.invitedRole]}
                      </OpPill>
                      <div className="flex shrink-0 gap-2">
                        <CopyLinkButton url={inviteUrl} />
                        <RevokeButton
                          organizationId={organization.id}
                          invitationToken={inv.invitationToken}
                          email={inv.email}
                          orgToken={orgToken}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </OpCard>
          )}
        </section>
      )}
    </div>
  );
}
