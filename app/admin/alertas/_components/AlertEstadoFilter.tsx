"use client";

// AlertEstadoFilter — the Estado control for /admin/alertas' bandeja
// (F-migration 2026-07-21, off the bespoke <form>).
//
// BUGFIX GUARD (same class of bug as CasoEstadoFilter,
// opfilterbar-sweep-2026-07-21): Estado's no-param default is "open" —
// STATUS_FILTER_LABEL's own "open" entry ("Abiertas (todas)") is a SPECIFIC,
// non-terminal-status subset, NOT "every alert regardless of status" (that is
// the SEPARATE "all" entry, "Todas"). An OpFilterBar `axis` always injects its
// own blank "Todas" option whose value clears the param — i.e. maps to "open"
// here, not to the real "all" — which would sit right beside the genuine
// "Todas" entry as an indistinguishable dead second option. Estado therefore
// renders as its own plain <select> in OpFilterBar's `children` slot instead
// of a registered axis, with exactly the STATUS_FILTER_LABEL options and
// nothing injected.
import { useSearchParams } from "next/navigation";
import { useId } from "react";

import { OpSelect } from "@/components/ui/dashboard/OpField";
import { serverNavCommit } from "@/lib/ui/filter-commit";

const captionClasses = "text-sm font-medium text-ln-op-ink-2";

export type AlertEstadoOption = { value: string; label: string };

export function AlertEstadoFilter({
  value,
  options,
}: {
  value: string;
  options: AlertEstadoOption[];
}) {
  const searchParams = useSearchParams();
  const id = useId();

  return (
    <label htmlFor={id} className="flex w-full flex-col gap-1 sm:w-auto">
      <span className={captionClasses}>Estado</span>
      <OpSelect
        id={id}
        className="min-h-11 w-full sm:w-auto sm:min-w-[12rem]"
        value={value}
        aria-label="Estado"
        onChange={(e) => {
          const next = e.target.value;
          // "open" is the default — clear the param instead of writing it
          // explicitly, matching the clean-URL-at-default convention.
          serverNavCommit(searchParams.toString())({ status: next === "open" ? null : next });
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </OpSelect>
    </label>
  );
}
