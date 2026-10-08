"use client";

// The field pieces both halves of PetForm draw: the read-only FULL-LOCK row,
// the age pair, the microchip block, the photo picker and the permanent
// conditions. Moved out of components/PetForm.tsx unchanged when "Editar datos"
// became its own sectioned form (owner-pet-actions, components/pet-form/
// PetEditForm.tsx), so the two forms draw one field one way.

import { LnChip } from "@/components/ui/Chip";
import { LnField, LnInput, LnSelect } from "@/components/ui/Field";
import { LnToggle } from "@/components/ui/Toggle";
import { MICROCHIP_LOCATIONS } from "@/lib/reference/lookups";
import {
  PERMANENT_CONDITIONS,
  PERMANENT_CONDITION_GROUPS,
  type PermanentCondition,
  permanentConditionGroup,
  permanentConditionLabel,
} from "@/lib/reference/permanent-conditions";
import { useState } from "react";

/**
 * Canonical microchip data for pre-filling the form in edit mode.
 * ARCH-S: replaces the dropped pets.microchipId* columns.
 * Sourced from pet_identifications by the edit page server component.
 */
export type ExistingCanonicalChip = {
  code: string | null;
  isoCountryCode: string | null;
  recordedAt: string | null;
  recordedByLabel: string | null;
  implantationSite: string | null;
};

/**
 * Read-only display for a locked field (FULL-LOCK: species, jurisdiction).
 * Shows the current value plus a hint explaining the governed change path and
 * an optional action link to that path. `children` carries hidden inputs so the
 * server-side parse still receives the (unchanged) value.
 */
export function LnReadOnlyField({
  label,
  value,
  hint,
  action,
  children,
}: {
  label: string;
  value: string;
  hint?: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]">
        {label}
      </p>
      <div className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-3 py-2.5">
        <span className="text-md text-[var(--color-ln-ink-2)]">{value}</span>
        <span
          aria-hidden="true"
          className="font-ln-mono text-xs uppercase tracking-[.12em] text-[var(--color-ln-faint)]"
        >
          Fijo
        </span>
      </div>
      {hint && <p className="font-ln-mono text-sm text-[var(--color-ln-mute)]">{hint}</p>}
      {action}
      {children}
    </div>
  );
}

export function LnAgeFields({
  defaultYears,
  defaultMonths,
}: {
  defaultYears: number | null;
  defaultMonths: number | null;
}) {
  const [years, setYears] = useState<string>(defaultYears != null ? String(defaultYears) : "");
  const [months, setMonths] = useState<string>(defaultMonths != null ? String(defaultMonths) : "");
  return (
    <div className="flex flex-col gap-1.5">
      <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]">
        Edad aproximada
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {/* B-6: aria-label so each input has an accessible name independent of id/label wiring */}
        <LnInput
          id="ageYears"
          name="ageYears"
          type="number"
          min="0"
          // NO `max` (alta-validacion-edad). The ceiling depends on the species
          // (`other` keeps 250) and on whether the age was TYPED: an age
          // pre-filled from a stored date passes at any value, so an owner
          // whose dog's date reads 76 years can still fix its colour. A browser
          // `max` would block that save before `updatePetAction` ever runs —
          // the server's `gateEditedAge` owns the range, with its own sentence.
          placeholder="Años"
          aria-label="Años de edad"
          value={years}
          onChange={(e) => setYears(e.target.value)}
        />
        <LnInput
          id="ageMonths"
          name="ageMonths"
          type="number"
          min="0"
          max="11"
          placeholder="Meses"
          aria-label="Meses de edad"
          value={months}
          onChange={(e) => setMonths(e.target.value)}
        />
      </div>
      <p className="font-ln-mono text-sm text-[var(--color-ln-mute)]">
        Si no sabés exacto, una estimación está bien.
      </p>
    </div>
  );
}

export function MicrochipBlock({
  existingCanonicalChip,
}: {
  // ARCH-S: canonical chip data replaces dropped pets.microchipId* columns.
  existingCanonicalChip?: ExistingCanonicalChip | null;
}) {
  const [microchipId, setMicrochipId] = useState<string>(existingCanonicalChip?.code ?? "");
  const [microchipCountryCode, setMicrochipCountryCode] = useState<string>(
    // 032 = ISO 3166 numeric code for Argentina. 858 (previously used here)
    // is Uruguay's code — a mislabel fixed in the QA nits sweep 2026-07.
    existingCanonicalChip?.isoCountryCode ?? "032",
  );
  const [microchipImplantedAt, setMicrochipImplantedAt] = useState<string>(
    existingCanonicalChip?.recordedAt ?? "",
  );
  const [microchipImplantedBy, setMicrochipImplantedBy] = useState<string>(
    existingCanonicalChip?.recordedByLabel ?? "",
  );
  const [microchipLocation, setMicrochipLocation] = useState<string>(
    existingCanonicalChip?.implantationSite ?? "",
  );

  return (
    <div className="flex flex-col gap-2.5 border-t border-[var(--color-ln-line-2)] pt-3">
      <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.12em] text-[var(--color-ln-faint)]">
        Microchip
      </p>
      <LnField label="Número de chip" hint="15 dígitos, ISO 11784/11785">
        {({ id, describedBy }) => (
          <LnInput
            id={id}
            name="microchipId"
            type="text"
            mono
            autoComplete="off"
            value={microchipId}
            onChange={(e) => setMicrochipId(e.target.value)}
            aria-describedby={describedBy}
          />
        )}
      </LnField>
      <LnField label="Código de país">
        {({ id, describedBy }) => (
          <LnInput
            id={id}
            name="microchipCountryCode"
            type="text"
            mono
            value={microchipCountryCode}
            onChange={(e) => setMicrochipCountryCode(e.target.value)}
            aria-describedby={describedBy}
          />
        )}
      </LnField>
      <LnField label="Fecha de implantación">
        {({ id, describedBy }) => (
          <LnInput
            id={id}
            name="microchipImplantedAt"
            type="date"
            mono
            value={microchipImplantedAt}
            onChange={(e) => setMicrochipImplantedAt(e.target.value)}
            aria-describedby={describedBy}
          />
        )}
      </LnField>
      <LnField label="Implantado por (vet / clínica)">
        {({ id, describedBy }) => (
          <LnInput
            id={id}
            name="microchipImplantedBy"
            type="text"
            value={microchipImplantedBy}
            onChange={(e) => setMicrochipImplantedBy(e.target.value)}
            aria-describedby={describedBy}
          />
        )}
      </LnField>
      <LnField label="Ubicación en el cuerpo">
        {({ id, describedBy, invalid }) => (
          <LnSelect
            id={id}
            name="microchipLocation"
            key={`microchipLocation-${microchipLocation}`}
            defaultValue={microchipLocation}
            onChange={(e) => setMicrochipLocation(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          >
            <option value="">No especificar</option>
            {MICROCHIP_LOCATIONS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </LnSelect>
        )}
      </LnField>
    </div>
  );
}

export function LnPhotoField({
  onFileChange,
  preview,
  optional = true,
}: {
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  preview: string | null;
  /**
   * `false` where the photo IS the act — the photo sheet — so the label does not
   * call optional the one thing the form is for. A form with other fields
   * (the alta, Editar datos) keeps the default.
   */
  optional?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]">
        Foto
        {optional && (
          <>
            {" "}
            <span className="font-normal lowercase tracking-[.04em] text-[var(--color-ln-faint)]">
              opcional
            </span>
          </>
        )}
      </p>
      <label
        htmlFor="photo"
        className="flex cursor-pointer items-center gap-3.5 rounded-[var(--radius-sm)] border border-dashed border-[var(--color-ln-line-strong)] p-3 transition-colors hover:bg-[var(--color-ln-stripe)]"
      >
        {preview ? (
          <img
            src={preview}
            alt="Vista previa de la mascota"
            className="h-[72px] w-[72px] flex-shrink-0 rounded-[var(--radius-sm)] object-cover"
          />
        ) : (
          <div className="flex h-[72px] w-[72px] flex-shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-ln-stripe)] text-sm text-[var(--color-ln-mute)]">
            Sin foto
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-md text-[var(--color-ln-ink-2)]">
            {preview ? "Cambiar foto" : "Tocá para elegir una foto"}
          </p>
          <p className="mt-0.5 font-ln-mono text-sm text-[var(--color-ln-mute)]">
            JPG o PNG, hasta 5 MB
          </p>
        </div>
      </label>
      <input
        id="photo"
        name="photo"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onFileChange}
        className="sr-only"
      />
    </div>
  );
}

/** The permanent-condition chips, grouped (sentidos, motora, médica, otra). */
export function PermanentConditionChips({
  conditions,
  onToggle,
}: {
  conditions: Set<PermanentCondition>;
  onToggle: (code: PermanentCondition) => void;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      {PERMANENT_CONDITION_GROUPS.map((group) => {
        const codes = PERMANENT_CONDITIONS.filter((c) => permanentConditionGroup(c) === group.id);
        if (codes.length === 0) return null;
        return (
          <div key={group.id} className="flex flex-col gap-1.5">
            <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-faint)]">
              {group.label}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {codes.map((code) => (
                <LnChip key={code} selected={conditions.has(code)} onChange={() => onToggle(code)}>
                  {permanentConditionLabel(code)}
                </LnChip>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The two switches that change what OTHER people see: the conditions on the
 * public credential (and /adoptar), and the medical-emergency notice.
 */
export function PublicDisclosureToggles({
  discloseConditions,
  emergencyInfoVisible,
  onDiscloseChange,
  onEmergencyChange,
}: {
  discloseConditions: boolean;
  emergencyInfoVisible: boolean;
  onDiscloseChange: (next: boolean) => void;
  onEmergencyChange: (next: boolean) => void;
}) {
  return (
    <>
      <LnToggle
        variant="azul"
        checked={discloseConditions}
        onChange={onDiscloseChange}
        label="Compartir estas condiciones en superficies públicas"
        description="Cuando está marcado, se muestran en la credencial pública y en /adoptar si el refugio publica al pet."
      />
      <LnToggle
        variant="azul"
        checked={emergencyInfoVisible}
        onChange={onEmergencyChange}
        label="Mostrar aviso de emergencia médica en la credencial pública"
        description="Aparece en la página pública sin revelar tu nombre ni datos sensibles."
      />
    </>
  );
}

/** The "otra" description — required once "otra" is chosen. */
export function ConditionOtherField({
  value,
  onChange,
  maxLength,
}: {
  value: string;
  onChange: (next: string) => void;
  maxLength: number;
}) {
  return (
    <LnField label="Especificá la condición" required>
      {({ id, describedBy, invalid }) => (
        <LnInput
          id={id}
          name="permanentConditionsOther"
          type="text"
          required
          maxLength={maxLength}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={describedBy}
          invalid={invalid}
        />
      )}
    </LnField>
  );
}
