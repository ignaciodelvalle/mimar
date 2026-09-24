"use client";

// AuditActionFilter — the Acción control for /admin/auditoria
// (F-migration 2026-07-21, off the bespoke <form>).
//
// Default (no `action` param) is genuinely "todas las acciones" — no
// blank-option trap here. This stays a `children` control (not a registered
// OpFilterBar `axis`) for a DIFFERENT reason: a multi-action KPI drill (e.g.
// Decisiones 7d = request_approved + request_rejected) can't be represented
// in a single-select, so it renders as a read-only locked chip instead — the
// SAME two-shape rendering the pre-migration <form> already did. Because this
// control isn't an axis, OpFilterBar's own chip removal / "Limpiar todo" can't
// reach it — the page keeps its own "Limpiar filtros" fallback link for that
// case (see page-level comment).
import { useSearchParams } from "next/navigation";
import { useId } from "react";

import { OpSelect } from "@/components/ui/dashboard/OpField";
import { serverNavCommit } from "@/lib/ui/filter-commit";

const captionClasses = "text-sm font-medium text-ln-op-ink-2";

export type AuditActionOption = { value: string; label: string };

export type AuditActionFilterProps = {
  /** Deduped-by-label dropdown options (buildAuditActionOptions). */
  actionOptions: AuditActionOption[];
  /** The option `value` matching the current single-action filter, or "". */
  selectedValue: string;
  /** Non-null when the current filter is a multi-action drill — renders the locked chip. */
  multiActionLabels: string[] | null;
  /** Extra searchParam keys to drop on commit (e.g. a keyset `cursor`). */
  resetParamsOnChange?: readonly string[];
};

export function AuditActionFilter({
  actionOptions,
  selectedValue,
  multiActionLabels,
  resetParamsOnChange = [],
}: AuditActionFilterProps) {
  const searchParams = useSearchParams();
  const id = useId();

  if (multiActionLabels) {
    return (
      <div className="flex w-full flex-col gap-1 sm:w-auto">
        <span className={captionClasses}>Acción</span>
        <span className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-3 text-sm text-ln-op-ink">
          {multiActionLabels.join(" + ")}
        </span>
      </div>
    );
  }

  return (
    <label htmlFor={id} className="flex w-full flex-col gap-1 sm:w-auto">
      <span className={captionClasses}>Acción</span>
      <OpSelect
        id={id}
        className="min-h-11 w-full sm:w-auto sm:min-w-[12rem]"
        value={selectedValue}
        aria-label="Acción"
        onChange={(e) => {
          serverNavCommit(searchParams.toString())(
            { action: e.target.value || null },
            resetParamsOnChange,
          );
        }}
      >
        <option value="">Todas las acciones</option>
        {actionOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </OpSelect>
    </label>
  );
}
