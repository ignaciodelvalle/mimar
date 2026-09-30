"use client";

// ChangeRoleSelect — inline role selector wired to changeMemberRoleAction.

import { useState, useTransition } from "react";

import { OpSelect } from "@/components/ui/dashboard/OpField";
import { notifySaved } from "@/lib/ui/action-feedback";
import { changeMemberRoleAction } from "@/src/modules/organizations/actions";

type Props = {
  organizationId: string;
  membershipId: string;
  currentRole: string;
  /** How the current role reads — shown even when it is no longer settable. */
  currentRoleLabel: string;
  settableRoles: { value: string; label: string }[];
};

export function ChangeRoleSelect({
  organizationId,
  membershipId,
  currentRole,
  currentRoleLabel,
  settableRoles,
}: Props) {
  // A member may hold a role this org can no longer assign — a coordinator or
  // volunteer in a clinic (portal-vet-p0 D13), or a foster. Their role stays
  // on screen as a disabled option: dropping it would render the FIRST option
  // as if it were theirs, and one careless change would silently demote them.
  const isLegacyRole = !settableRoles.some((r) => r.value === currentRole);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState(currentRole);

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const newRole = e.target.value;
    if (newRole === selectedRole) return;
    setError(null);
    setSelectedRole(newRole);
    startTransition(async () => {
      const result = await changeMemberRoleAction({
        organizationId,
        membershipId,
        newRole,
      });
      if ("error" in result) {
        setError(result.error);
        setSelectedRole(currentRole);
      } else {
        // Tier B: the optimistic selectedRole (with revert above) is the
        // terminal UI state — no router.refresh(); it is banned (silent-drop
        // defect, see lib/ui/full-page-action-nav.ts). Toast is the
        // confirmation instead.
        notifySaved("Rol actualizado");
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <OpSelect
        value={selectedRole}
        onChange={handleChange}
        disabled={pending}
        size="xs"
        block={false}
      >
        {isLegacyRole && (
          <option value={currentRole} disabled>
            {currentRoleLabel}
          </option>
        )}
        {settableRoles.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </OpSelect>
      {error && (
        <p className="text-sm text-ln-op-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
