"use client";

// Shared "Motivo" textarea for admin revoke/deactivate actions, with an inline
// character counter on the label row. Compact admin-tier register — intentionally
// NOT a Poncho Field (its mb-7 + min-h-24 + semibold label would regress this
// dense layout; the char-counter sits on the label row, which Field has no slot
// for). Previously duplicated verbatim across 5 call sites:
//   - app/gob/usuarios/RevokeUserActions.tsx
//   - app/gob/organizaciones/RevokeOrgActions.tsx
//   - app/admin/govts/_components/RevokeLocalityRowActions.tsx
//   - app/admin/govts/_components/DeactivateGovtForm.tsx
//   - app/admin/admins/_components/DeactivateAdminForm.tsx
// Three of those hardcoded the textarea id (duplicate-id smell when more than one
// row renders); this shared version derives it from useId().

import { OpTextarea } from "@/components/ui/dashboard/OpField";
import { useId } from "react";

/** Minimum length for an action-reason. Consumers reuse it for submit validation. */
export const MOTIVO_MIN = 30;

export function MotivoField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  const len = value.trim().length;
  const tooShort = len < MOTIVO_MIN;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="block text-xs uppercase tracking-wider text-ln-op-mute">
          Motivo (mínimo {MOTIVO_MIN} caracteres)
        </label>
        <span
          className={`text-xs tabular-nums ${tooShort ? "text-ln-op-danger" : "text-ln-op-mute"}`}
        >
          {len}/{MOTIVO_MIN}
        </span>
      </div>
      <OpTextarea
        id={id}
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        size="xs"
      />
    </div>
  );
}
