"use client";

import { useActionState, useState } from "react";

import { type UpgradeFormState, createOrganizationAction } from "@/app/actions/upgrade";
import { LocationFields } from "@/components/LocationFields";
import { LnField, LnInput, LnSelect } from "@/components/ui/Field";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useKeptFields } from "@/lib/ui/use-kept-fields";

const initialState: UpgradeFormState = { error: null };

// DNI_PREREQ_URL: canonical ?next= pattern so the user lands back here after
// declaring their DNI. Kept here so it matches the server-action value exactly.
const DNI_PREREQ_URL = "/cuenta/verificar-dni?next=/cuenta/upgrade";

// sanitary_authority is a government classification — self-registration is blocked
// both here (UI) and server-side in createOrganizationForUser. Govt orgs are
// provisioned out-of-band by platform admins.
const ORG_TYPE_OPTIONS = [
  { value: "shelter", label: "Refugio / albergue" },
  { value: "rescue_network", label: "Red de rescate" },
  { value: "clinic", label: "Clínica veterinaria" },
  { value: "other", label: "Otro" },
] as const;

type Props = {
  /**
   * Whether the current user has already declared their DNI.
   * Passed from the server page — checked before rendering the form so the
   * requirement is visible BEFORE the user fills any fields.
   */
  dniVerified: boolean;
};

export function OrgCreateForm({ dniVerified }: Props) {
  // forms/react19-reset-data-loss-inventory: `orgType` is a <select> — a
  // controlled select falls back to its FIRST option on the reset that
  // follows a rejected submit (measured in
  // __tests__/react19-form-reset-contract.test.tsx), unlike the text fields
  // below, which stay put because they're genuinely controlled.
  const { boundAction, kept } = useKeptFields<UpgradeFormState>(createOrganizationAction);
  const [state, formAction, pending] = useActionState(boundAction, initialState);
  useActionRedirect(state.redirectTo, state);

  // Controlled field values — preserved across server-side validation errors so
  // the user doesn't lose what they typed when e.g. the CUIT format is rejected.
  const [name, setName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [orgType, setOrgType] = useState("");
  const [email, setEmail] = useState("");
  const [cuit, setCuit] = useState("");
  const [phone, setPhone] = useState("");
  const [personeriaJuridicaNumber, setPersoneriaJuridicaNumber] = useState("");

  // Show requirement UP FRONT: if DNI is not declared, gate the form entirely.
  // The server action also checks this, but surfacing it here avoids making the
  // user fill the form only to discover the blocker on submit.
  const missingDni = !dniVerified || (state.missingPrereq === "dni" && Boolean(state.prereqUrl));

  if (missingDni) {
    return (
      <div className="space-y-3">
        {/* Requirements panel */}
        <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-4 py-3">
          <p className="text-sm font-semibold uppercase tracking-[.08em] text-[var(--color-ln-mute)]">
            Requisitos para crear una organización
          </p>
          <ul className="mt-2 space-y-1.5">
            <li className="flex items-center gap-2 text-md text-[var(--color-ln-ink-2)]">
              {/* X — not met */}
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 text-[var(--color-ln-err)]"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
              DNI declarado
            </li>
          </ul>
        </div>

        {/* CTA */}
        <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-warn-050)] p-4 space-y-2">
          <p className="text-sm font-medium text-[var(--color-ln-warn)]">
            Antes de crear una organización, declará tu DNI.
          </p>
          <p className="text-xs text-[var(--color-ln-warn)]">
            miMAR requiere que declares tu DNI antes de crear una organización.
          </p>
          <a
            href={state.prereqUrl ?? DNI_PREREQ_URL}
            className="inline-block mt-1 px-4 py-2 rounded-[var(--radius-pill)] bg-[var(--color-ln-warn)] text-white text-sm font-medium hover:opacity-90 transition-colors"
          >
            Declarar DNI →
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Requirements met indicator */}
      <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-ok-100)] bg-[var(--color-ln-ok-050)] px-4 py-3">
        <p className="text-sm font-semibold uppercase tracking-[.08em] text-[var(--color-ln-mute)]">
          Requisitos para crear una organización
        </p>
        <ul className="mt-2 space-y-1.5">
          <li className="flex items-center gap-2 text-md text-[var(--color-ln-ink-2)]">
            {/* Checkmark — met */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0 text-[var(--color-ln-ok)]"
              aria-hidden="true"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            DNI declarado
          </li>
        </ul>
      </div>

      <form action={formAction} className="space-y-4">
        <LnField
          label="Nombre de la organización"
          required
          hint="Nombre público que verán los demás usuarios."
        >
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              name="name"
              type="text"
              required
              aria-describedby={describedBy}
              invalid={invalid}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </LnField>

        <LnField
          label="Razón social"
          required
          hint="Nombre legal completo (ej: Asoc. Civil Refugio El Campito)."
        >
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              name="legalName"
              type="text"
              required
              aria-describedby={describedBy}
              invalid={invalid}
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
            />
          )}
        </LnField>

        <LnField label="Tipo de organización" required>
          {({ id, describedBy, invalid }) => (
            <LnSelect
              id={id}
              name="orgType"
              key={`orgType-${kept("orgType")}`}
              required
              aria-describedby={describedBy}
              invalid={invalid}
              defaultValue={kept("orgType", orgType)}
              onChange={(e) => setOrgType(e.target.value)}
            >
              <option value="">Seleccioná un tipo</option>
              {ORG_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </LnSelect>
          )}
        </LnField>

        <LnField label="Correo electrónico de contacto" required>
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              name="email"
              type="email"
              required
              aria-describedby={describedBy}
              invalid={invalid}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </LnField>

        <LnField label="CUIT" hint="11 dígitos sin guiones. Ej: 30712345678">
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              name="cuit"
              type="text"
              aria-describedby={describedBy}
              invalid={invalid}
              value={cuit}
              onChange={(e) => setCuit(e.target.value)}
            />
          )}
        </LnField>

        <LnField label="Teléfono">
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              name="phone"
              type="tel"
              aria-describedby={describedBy}
              invalid={invalid}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          )}
        </LnField>

        {/* Jurisdiction — L1 (province + locality) per AGENTS.md "Design rules"
            rule #1. LocationFields submits `provinceCode` and `localityName`;
            the createOrganizationAction reads those keys plus the legacy
            `jurisdictionProvince` / `jurisdictionLocality` aliases for
            backward compatibility. */}
        <div className="space-y-1">
          <p className="block mb-2.5 text-[0.88em] font-semibold text-[var(--color-ln-mute)]">
            Jurisdicción
          </p>
          <p className="text-xs text-[var(--color-ln-mute)] mb-2">
            Para enrutar la verificación al govt correspondiente.
          </p>
          <LocationFields mode="l1" cascade />
        </div>

        <LnField label="Número de personería jurídica">
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              name="personeriaJuridicaNumber"
              type="text"
              aria-describedby={describedBy}
              invalid={invalid}
              value={personeriaJuridicaNumber}
              onChange={(e) => setPersoneriaJuridicaNumber(e.target.value)}
            />
          )}
        </LnField>

        {state.error && (
          <p className="text-sm text-[var(--color-ln-err)]" role="alert">
            {state.error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="w-full px-4 py-3 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] text-white font-medium hover:bg-[var(--color-ln-azul-700)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {pending ? "Creando organización..." : "Crear organización"}
        </button>
      </form>
    </div>
  );
}
