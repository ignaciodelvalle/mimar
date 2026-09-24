"use client";

// LegalMetadataFieldset — shared fieldset for the govt_business_rules legal
// provenance COLUMNS (migration 0183, spec RM5): requirement tier, legal
// basis, authority, source URL and effective dates. Mounted by EVERY rule
// form (existing 11 + the new obligation forms) so any rule can document
// WHICH law backs it; parsed server-side by the action shim's
// parseLegalMetadata — these fields never pass through the rule-type Zod
// validators because they are not payload.
//
// The requirement tier select renders only when `requirementLevel` is
// provided (obligation-carrying types: rabies_vaccination, sterilization,
// microchip_required). Forms that do not render it simply do not submit the
// field, and the writer leaves the column untouched — so editing e.g. a PPP
// rule never erases its backfilled tier.

import { useState } from "react";

import { LnField, LnInput, LnSelect } from "@/components/ui/Field";
import type { RequirementLevel } from "@/db";
import { REQUIREMENT_LEVEL_LABELS } from "@/lib/domain/rule-types-registry";

/** Initial values read off an existing row's COLUMNS (edit mode). */
export type LegalMetadataInitial = {
  requirementLevel: RequirementLevel | null;
  legalBasis: string | null;
  authority: string | null;
  sourceUrl: string | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
};

type RequirementLevelSelectProps = {
  /** Current tier — "" renders the explicit "Sin definir" option. */
  value: RequirementLevel | "";
  onChange: (value: RequirementLevel | "") => void;
  /** Offer the empty "Sin definir" option (obligation forms yes, microchip no). */
  allowUnset?: boolean;
};

type Props = {
  initial?: LegalMetadataInitial | null;
  /** Absent = no tier select rendered (the field is not submitted at all). */
  requirementLevel?: RequirementLevelSelectProps;
};

export function LegalMetadataFieldset({ initial, requirementLevel }: Props) {
  // forms/react19-reset-data-loss-inventory: mounted by ~11 rule forms, none
  // of which own the useActionState action THIS fieldset would need to wrap
  // with `useKeptFields` — so the fix lives here instead, once, covering all
  // of them. React 19 resets the parent's `<form>` when its action settles,
  // including on error, and every field below was uncontrolled
  // (`defaultValue={initial?.x ?? ""}`), so a rejected submit put back the
  // row's ORIGINAL value — on an edit, silently discarding the correction
  // the operator just typed. Per the contract measured in
  // __tests__/react19-form-reset-contract.test.tsx, "a field is safe when
  // its value is bound to React state AND is a text-ish input or textarea" —
  // so these are lifted to local state instead of chasing the parent's
  // action, which the hook needs and this component does not have.
  //
  // CALLER CONTRACT (fresh-context review, T4-F1 batch 2): the five
  // `useState(initial?.x ?? "")` calls below seed from `initial` on the
  // FIRST render only — React never re-reads an initializer after mount. If
  // a caller ever swapped WHICH row's `initial` this fieldset edits without
  // remounting the component (a different `key`, or navigating between two
  // rules' edit screens without a route change), the fields would keep
  // showing the PREVIOUS row's values. Every current caller is safe because
  // the router remounts this component on every `ruleId` navigation — but
  // that safety lives in the callers, not here, and nothing enforces it. A
  // caller that stops remounting on a rule change must pass a `key` derived
  // from the row's id (the same reasoning as the `<select>` `key` trick two
  // fields down, just at the component boundary instead of the DOM one).
  const [legalBasis, setLegalBasis] = useState(initial?.legalBasis ?? "");
  const [authority, setAuthority] = useState(initial?.authority ?? "");
  const [sourceUrl, setSourceUrl] = useState(initial?.sourceUrl ?? "");
  const [effectiveFrom, setEffectiveFrom] = useState(initial?.effectiveFrom ?? "");
  const [effectiveUntil, setEffectiveUntil] = useState(initial?.effectiveUntil ?? "");

  return (
    <fieldset className="space-y-5 rounded-lg border border-ln-op-line p-4">
      <legend className="px-1 text-md font-semibold text-ln-op-ink">Respaldo normativo</legend>
      <p className="text-md text-ln-op-ink-2">
        Qué norma respalda esta regla. Todos los campos son opcionales: si no hay una cita
        verificada, dejalos vacíos — el sistema nunca inventa normativa.
      </p>

      {requirementLevel && (
        <LnField label="Nivel de exigencia">
          {({ id, describedBy, invalid }) => (
            <LnSelect
              // UNCONTROLLED on purpose, with a `key` derived from the
              // parent's value: react-dom restores a <select> from
              // `defaultSelected` on RESET, and only a MOUNT writes that
              // attribute (`postMountWrapper`; `updateSelect` never does —
              // see lib/ui/use-kept-fields.ts). A genuinely `value`-bound
              // controlled select was MEASURED to fall back to its first
              // option regardless (same failure as the contract test's
              // "controlled-select" case) — the fix is the same one the hook
              // uses: drop `value`, key on it instead, and let the resulting
              // REMOUNT re-run the mount path every time the parent's tier
              // changes (including the one caused by the user's own pick,
              // which is what keeps this visually in sync with `onChange`
              // without ever going through React's controlled-value path).
              key={`requirement-level-${requirementLevel.value}`}
              id={id}
              name="requirement_level"
              defaultValue={requirementLevel.value}
              onChange={(e) => requirementLevel.onChange(e.target.value as RequirementLevel | "")}
              aria-describedby={describedBy}
              invalid={invalid}
            >
              {requirementLevel.allowUnset && <option value="">Sin definir</option>}
              {Object.entries(REQUIREMENT_LEVEL_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </LnSelect>
          )}
        </LnField>
      )}

      <LnField label="Base legal">
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="legal_basis"
            type="text"
            value={legalBasis}
            onChange={(e) => setLegalBasis(e.target.value)}
            placeholder="Ley / ordenanza / decreto"
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      <LnField label="Autoridad de aplicación">
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="authority"
            type="text"
            value={authority}
            onChange={(e) => setAuthority(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      <LnField label="Fuente (URL)">
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="source_url"
            type="url"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://…"
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      <LnField label="Vigente desde">
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="effective_from"
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      <LnField label="Vigente hasta">
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="effective_until"
            type="date"
            value={effectiveUntil}
            onChange={(e) => setEffectiveUntil(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>
    </fieldset>
  );
}
