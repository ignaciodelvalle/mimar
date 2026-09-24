"use client";

// SearchFilterField — shared free-text search children-slot control for
// OpFilterBar screens whose query is a free-text string (not a bounded set of
// options), so it can never be a registered `axis` (an axis's implicit "" ⇒
// blank-"Todas" option only makes sense for an enumerable value set). Commits
// on submit (not per-keystroke) via the SAME serverNavCommit primitive every
// other OpFilterBar control uses (full-document nav, immune to the Next
// 15.5.18 router-drop defect, engram #621/#622) — mirrors
// DateRangeFilterFields/JurisdictionFilterFields' "commit together on submit"
// rationale (F-migration 2026-07-21, /gob/usuarios + /admin/usuarios twin).
import { useSearchParams } from "next/navigation";
import { type FormEvent, useId } from "react";

import { OpButton } from "@/components/ui/dashboard/OpButton";
import { serverNavCommit } from "@/lib/ui/filter-commit";

const captionClasses = "text-sm font-medium text-ln-op-ink-2";

// PO fix (validacion-A 2026-07-23): sm:w-56 (224px) clipped every placeholder
// longer than ~28 characters (e.g. "Buscar por nombre de mascota o dueño/a",
// "Buscar por nombre, razón social o CUIT") — the affordance describing what's
// searchable was unreadable without focusing + selecting the text. w-80 (320px)
// comfortably fits the longest surviving consumer placeholder (~40 chars at
// text-sm) with margin; shortened outliers (see CredencialesScreen) stay well
// under that too.
const inputClasses =
  "h-11 w-full rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-3 text-sm " +
  "text-ln-op-ink placeholder:text-ln-op-mute focus:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ln-op-azul sm:w-80";

export type SearchFilterFieldProps = {
  /** searchParam key for the query string. Default "q". */
  paramKey?: string;
  /** Current value, or null/undefined when unset. */
  value?: string | null;
  /** Visible caption above the input. Default "Buscar". */
  label?: string;
  placeholder?: string;
  /** Label for the submit button. Default "Buscar". */
  submitLabel?: string;
  /** Extra searchParam keys to drop on commit (e.g. a keyset `cursor`). */
  resetParamsOnChange?: readonly string[];
};

export function SearchFilterField({
  paramKey = "q",
  value,
  label = "Buscar",
  placeholder,
  submitLabel = "Buscar",
  resetParamsOnChange = [],
}: SearchFilterFieldProps) {
  const searchParams = useSearchParams();
  const uid = useId();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const q = ((data.get(paramKey) as string | null) ?? "").trim() || null;
    serverNavCommit(searchParams.toString())({ [paramKey]: q }, resetParamsOnChange);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
      <label htmlFor={uid} className="flex w-full flex-col gap-1 sm:w-auto">
        <span className={captionClasses}>{label}</span>
        <input
          id={uid}
          name={paramKey}
          type="text"
          defaultValue={value ?? ""}
          placeholder={placeholder}
          className={inputClasses}
        />
      </label>
      <OpButton type="submit" variant="primary" size="sm" className="h-11 px-4">
        {submitLabel}
      </OpButton>
    </form>
  );
}
