"use client";

// EmergencyContactFields — the 4-field vet/emergency-contact group, shared
// by two hosts (pet-document-redesign ADR-13, Phase 5):
//   1. app/(app)/cuenta/editar/EditProfileForm.tsx (full profile edit form)
//   2. app/(app)/mis-mascotas/[publicToken]/_emergencia/EmergencyContactSheet.tsx
//      (`?sheet=emergencia` — narrow in-profile edit, ADR-13)
//
// Extracted verbatim from EditProfileForm (~L278-362) — same fieldset,
// labels, placeholders, and PhoneFormatWarning behavior. Controlled: the
// host owns the state (useState in EditProfileForm; a small local state in
// the sheet) and passes `values` + a single `onChange(field, value)`.
//
// wave-3 D1 (design-system audit finding 1): the 4 fields used to hand-roll
// their own <label>/<input> pair, duplicating LnField/LnInput exactly and
// losing the mobile iOS-zoom hardening + focus-ring wiring those primitives
// provide. Field ids are now LnField's own generated ids (useId()) instead
// of the fixed "preferredVetName" etc. — nothing outside this component
// referenced the old literal ids (verified: no external anchors/queries).

import { LnField, LnInput } from "@/components/ui/Field";
import { looksLikeArPhone } from "@/lib/reference/ar-phone";

export type EmergencyContactValues = {
  preferredVetName: string;
  preferredVetPhone: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
};

type Props = {
  values: EmergencyContactValues;
  onChange: (field: keyof EmergencyContactValues, value: string) => void;
  /** Renders the surrounding <fieldset>/legend/intro copy. Default: true. */
  framed?: boolean;
};

function PhoneFormatWarning({ value }: { value: string }) {
  if (!value || looksLikeArPhone(value)) return null;
  return (
    <p className="mt-1 text-xs text-[var(--color-ln-warn)]">
      Formato inusual para Argentina — guardamos igual, revisalo si querés.
    </p>
  );
}

function FieldsGrid({ values, onChange }: Props) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <LnField label="Veterinario/a de cabecera">
        {({ id }) => (
          <LnInput
            id={id}
            type="text"
            value={values.preferredVetName}
            onChange={(e) => onChange("preferredVetName", e.target.value)}
            maxLength={80}
            placeholder="Dra. Pérez"
          />
        )}
      </LnField>
      <div>
        <LnField label="Teléfono del vet">
          {({ id }) => (
            <LnInput
              id={id}
              type="tel"
              value={values.preferredVetPhone}
              onChange={(e) => onChange("preferredVetPhone", e.target.value)}
              placeholder="+54 9 11 1234-5678"
            />
          )}
        </LnField>
        <PhoneFormatWarning value={values.preferredVetPhone} />
      </div>
      <LnField label="Contacto de emergencia">
        {({ id }) => (
          <LnInput
            id={id}
            type="text"
            value={values.emergencyContactName}
            onChange={(e) => onChange("emergencyContactName", e.target.value)}
            maxLength={80}
            placeholder="Lucía F."
          />
        )}
      </LnField>
      <div>
        <LnField label="Teléfono del contacto">
          {({ id }) => (
            <LnInput
              id={id}
              type="tel"
              value={values.emergencyContactPhone}
              onChange={(e) => onChange("emergencyContactPhone", e.target.value)}
              placeholder="+54 9 11 1234-5678"
            />
          )}
        </LnField>
        <PhoneFormatWarning value={values.emergencyContactPhone} />
      </div>
    </div>
  );
}

export function EmergencyContactFields({ values, onChange, framed = true }: Props) {
  if (!framed) return <FieldsGrid values={values} onChange={onChange} />;

  return (
    <fieldset
      id="emergencia"
      className="scroll-mt-6 space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] p-4"
    >
      <legend className="px-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-ln-mute)]">
        Contactos para emergencias
      </legend>
      <p className="text-xs text-[var(--color-ln-mute)]">
        Aparecen en la credencial de cada mascota. Si una mascota está perdida y un finder escanea
        el QR, podemos mostrarle estos contactos (según tus preferencias de privacidad).
      </p>
      <FieldsGrid values={values} onChange={onChange} />
    </fieldset>
  );
}
