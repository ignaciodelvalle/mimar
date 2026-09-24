"use client";

// AuditMineToggle — the "Ver solo mi actividad" control shared by the audit-
// history twins (/gob/historial, /admin/historial), F-migration
// 2026-07-21 cluster 2.
//
// BEFORE: a one-way `<a href="?actor={userId}">Ver solo mi actividad</a>` link
// — it could SET the actor filter to the viewer but never toggle it back off
// from itself (only re-picking a different actor in the dropdown, or
// "Limpiar filtros", cleared it).
//
// AFTER: a real checkbox in OpFilterBar's `children` slot. Checked ⇄
// actor=<userId>; unchecked ⇄ no actor param (the page's genuine "todos los
// actores" default) — so this is a TOGGLE, not an axis: the Actor dropdown is
// already a registered `axis` with the correct "all" default, and this
// control writes the SAME `actor` param via the SAME serverNavCommit
// primitive, exactly mirroring the pre-migration page's two affordances
// (dropdown + quick link) over one param. Uses `defaultChecked` (uncontrolled,
// same as VerifiedFilterCheckbox on /gob/vigilancia/brotes) — every commit is
// a full-document navigation, so the server-rendered checked state is always
// fresh on the next paint.
//
// ROOT-CAUSE FIX (R3, opfilterbar-sweep-2026-07-21): OpCheckbox's own label
// is a single-row `flex items-start` (checkbox + text, no caption line above
// it) — roughly 20px tall. Every axis select AND every other children
// control (CasoEstadoFilter/AlertEstadoFilter/AuditActionFilter) is a TWO-row
// stack: a caption line, then a min-h-11 (44px) control. OpFilterBar's
// domain-group row aligns everything with `items-end` (bottom-aligned), so a
// bare OpCheckbox bottom-aligned its short ~20px row against the ~68px
// caption+select stacks beside it — sitting well below their vertical center
// instead of level with them. Fix: wrap it in the SAME two-row shape (an
// invisible caption-height spacer + a min-h-11 row) so `items-end`
// bottom-aligns the same box height as every select, and the checkbox lands
// vertically centered in it — level with the selects, exactly like
// CasoEstadoFilter et al.
import { useSearchParams } from "next/navigation";

import { OpCheckbox } from "@/components/ui/dashboard/OpField";
import { serverNavCommit } from "@/lib/ui/filter-commit";

// Matches OpFilterBar's own `captionClasses` (text-sm font-medium) — used
// here ONLY as an invisible spacer so this control's box height matches an
// axis select's (caption line + min-h-11), not to show any text.
const captionSpacerClasses = "text-sm font-medium invisible select-none";

export type AuditMineToggleProps = {
  /** The viewer's own user id — the value written to `actor` when checked. */
  userId: string;
  /** Whether the CURRENT actor filter already equals the viewer (checked state). */
  isMine: boolean;
  /** Extra searchParam keys to drop on commit (e.g. a keyset `cursor`). */
  resetParamsOnChange?: readonly string[];
};

export function AuditMineToggle({
  userId,
  isMine,
  resetParamsOnChange = [],
}: AuditMineToggleProps) {
  const searchParams = useSearchParams();

  return (
    <div className="flex w-full flex-col gap-1 sm:w-auto">
      <span aria-hidden="true" className={captionSpacerClasses}>
        &nbsp;
      </span>
      <div className="flex min-h-11 items-center">
        <OpCheckbox
          defaultChecked={isMine}
          onChange={(e) => {
            serverNavCommit(searchParams.toString())(
              { actor: e.currentTarget.checked ? userId : null },
              resetParamsOnChange,
            );
          }}
        >
          Ver solo mi actividad
        </OpCheckbox>
      </div>
    </div>
  );
}
