// Invite member page — server guard + role computation, then delegates to InviteForm.
//
// Grantable roles: roles with rank ≤ inviter's rank, excluding foster
// (comes via foster-proposal flow per spec org-invitations v1).
// This mirrors the exact bounding the server action applies so the form
// only ever presents roles the action will accept.

import { redirect } from "next/navigation";

import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { ROLE_RANK } from "@/src/modules/organizations/domain/role-rules";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";

import { getSettableRoles } from "../member-management";
import { InviteForm } from "./InviteForm";

export default async function InvitarMiembroPage({
  params,
}: {
  params: Promise<{ orgToken: string }>;
}) {
  const { orgToken } = await params;
  const { organization, membership } = await requireOrgAccessByToken(orgToken);

  const granted = await getGrantedCapabilities(membership);
  if (!granted.has("member.invite")) {
    // Redirect back to the members list if the user lost the capability.
    redirect(`/org/${orgToken}/miembros`);
  }

  // The ONE settable-role list (rank ≤ the inviter's, foster excluded, and
  // coordinator/volunteer only in a rehoming org — portal-vet-p0 D13). The
  // server applies the same bounds, so the form never offers a role the action
  // refuses.
  const grantableRoleOptions = getSettableRoles(membership.role, organization.orgType);

  // Default the form to the LEAST-privileged grantable role, not the list's
  // first entry (which is "admin" whenever the inviter is an admin). An
  // invite left unchanged should never land as admin by accident.
  const defaultRole = [...grantableRoleOptions.map((r) => r.value)].sort(
    (a, b) => ROLE_RANK[a as keyof typeof ROLE_RANK] - ROLE_RANK[b as keyof typeof ROLE_RANK],
  )[0];

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">Equipo</p>
        <h1 className="text-title font-semibold text-ln-op-ink">Invitar miembro</h1>
        <p className="mt-1 text-md text-ln-op-mute">
          La persona recibirá un link para unirse a {organization.displayName}. El link vence en 14
          días.
        </p>
      </div>
      <InviteForm
        organizationId={organization.id}
        orgToken={orgToken}
        grantableRoles={grantableRoleOptions}
        defaultRole={defaultRole}
      />
    </div>
  );
}
