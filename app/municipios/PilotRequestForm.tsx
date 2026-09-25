"use client";

// Contact form on /municipios (WU6; "Contactate con el equipo" since the PO
// review of 2026-09-25). Posts to requestPilotAction, which
// mails our own pilots mailbox with Reply-To set to the requester. Nothing is
// stored. Rules and copy of the refusals live in lib/outreach/pilot-request.ts.
//
// React 19 resets a `<form action>` when its action settles, refusals
// included; useKeptFields re-seeds every field from the submitted FormData so
// a person who mistyped one field does not lose the other nine.

import Link from "next/link";
import { useActionState, useState } from "react";

import { searchLocalitiesPublicAction } from "@/app/actions/localities";
import { LocalityPickerAcross } from "@/components/LocalityPickerAcross";
import { LnButton } from "@/components/ui/Button";
import { LnCheckbox, LnField, LnInput, LnSelect, LnTextarea } from "@/components/ui/Field";
import {
  ORGANISM_TYPES,
  ORGANISM_TYPE_LABELS,
  PILOT_FIELDS,
  PILOT_INITIAL_STATE,
  PILOT_LIMITS,
  type PilotFieldKey,
} from "@/lib/outreach/pilot-request";
import { PROVINCES } from "@/lib/reference/ar-provincias";
import { useKeptFields } from "@/lib/ui/use-kept-fields";

import { requestPilotAction } from "./actions";

export function PilotRequestForm() {
  const { boundAction, kept, keptChecked } = useKeptFields(requestPilotAction);
  const [state, formAction, isPending] = useActionState(boundAction, PILOT_INITIAL_STATE);

  const errors: Partial<Record<PilotFieldKey, string>> =
    state.status === "invalid" ? state.fieldErrors : {};

  const failure =
    state.status === "rate_limited" || state.status === "unavailable" || state.status === "invalid"
      ? state.message
      : null;

  // ONE live region, mounted from the first render and never swapped out, so
  // a screen reader announces both outcomes: the success line and the
  // refusal summary. A region that appears together with its text is not
  // reliably announced.
  const announcement = state.status === "sent" ? "Recibimos tu mensaje." : (failure ?? "");

  return (
    <>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {state.status === "sent" ? (
        <div className="lp-mun-sent">
          <h3 className="lp-display lp-h-sub">Recibimos tu mensaje.</h3>
          <p>
            Te escribimos al correo que dejaste para coordinar una demo de cinco minutos sobre tu
            territorio. Te respondemos a la brevedad.
          </p>
        </div>
      ) : (
        <PilotFields
          formAction={formAction}
          isPending={isPending}
          failure={failure}
          errors={errors}
          kept={kept}
          keptChecked={keptChecked}
        />
      )}
    </>
  );
}

type FieldsProps = {
  formAction: (formData: FormData) => void;
  isPending: boolean;
  failure: string | null;
  errors: Partial<Record<PilotFieldKey, string>>;
  kept: (name: string, fallback?: string) => string;
  keptChecked: (name: string, fallback: boolean, value?: string) => boolean;
};

function PilotFields({ formAction, isPending, failure, errors, kept, keptChecked }: FieldsProps) {
  const [provinceCode, setProvinceCode] = useState("");
  const [organismType, setOrganismType] = useState("");

  return (
    <form action={formAction} className="lp-mun-form" noValidate>
      {/* Honeypot: invisible to people and to assistive tech, irresistible to bots. */}
      <div className="lp-mun-hp" aria-hidden="true">
        <label>
          No completes este campo
          <input
            type="text"
            name={PILOT_FIELDS.honeypot}
            tabIndex={-1}
            autoComplete="off"
            defaultValue={kept(PILOT_FIELDS.honeypot)}
          />
        </label>
      </div>

      <div className="lp-mun-form-grid">
        <LnField label="Tipo de organismo" required error={errors.organismType}>
          {({ id, describedBy, invalid }) => (
            <LnSelect
              id={id}
              name={PILOT_FIELDS.organismType}
              key={`type-${kept(PILOT_FIELDS.organismType)}`}
              defaultValue={kept(PILOT_FIELDS.organismType)}
              onChange={(e) => setOrganismType(e.target.value)}
              aria-describedby={describedBy}
              invalid={invalid}
              required
            >
              <option value="">Elegí una opción</option>
              {ORGANISM_TYPES.map((type) => (
                <option key={type} value={type}>
                  {ORGANISM_TYPE_LABELS[type]}
                </option>
              ))}
            </LnSelect>
          )}
        </LnField>

        <LnField
          label="Organismo o área"
          hint="Por ejemplo: Dirección de Zoonosis."
          required
          error={errors.organismName}
        >
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              name={PILOT_FIELDS.organismName}
              defaultValue={kept(PILOT_FIELDS.organismName)}
              maxLength={PILOT_LIMITS.organismName}
              aria-describedby={describedBy}
              invalid={invalid}
              required
            />
          )}
        </LnField>

        <LnField label="Provincia" required error={errors.province}>
          {({ id, describedBy, invalid }) => (
            <LnSelect
              id={id}
              name={PILOT_FIELDS.province}
              key={`province-${kept(PILOT_FIELDS.province)}`}
              defaultValue={kept(PILOT_FIELDS.province)}
              onChange={(e) => setProvinceCode(e.target.value)}
              aria-describedby={describedBy}
              invalid={invalid}
              required
            >
              <option value="">Elegí una provincia</option>
              {PROVINCES.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
            </LnSelect>
          )}
        </LnField>

        <div className="flex flex-col">
          <label
            htmlFor="pilot-locality-input"
            className="mb-1.5 flex items-center gap-1 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]"
          >
            Localidad
            {(organismType || kept(PILOT_FIELDS.organismType)) === "municipio" ? (
              <span className="text-[var(--color-ln-seal)]" aria-hidden="true">
                *
              </span>
            ) : (
              <span className="font-normal lowercase tracking-[.04em] text-[var(--color-ln-faint)]">
                opcional
              </span>
            )}
          </label>
          <LocalityPickerAcross
            // Remount on province change: a locality from the previous province
            // is never carried over.
            key={`locality-${provinceCode || kept(PILOT_FIELDS.province)}`}
            id="pilot-locality"
            name={PILOT_FIELDS.locality}
            scopeProvinceCode={provinceCode || kept(PILOT_FIELDS.province) || null}
            disabled={!(provinceCode || kept(PILOT_FIELDS.province))}
            defaultValue={{
              provinceCode: kept(PILOT_FIELDS.province) || null,
              localityName: kept(PILOT_FIELDS.locality) || null,
            }}
            placeholder={
              provinceCode || kept(PILOT_FIELDS.province)
                ? "Buscar localidad…"
                : "Primero elegí la provincia"
            }
            searchAction={searchLocalitiesPublicAction}
          />
          {errors.locality ? (
            <p className="mt-1 font-ln-mono text-sm text-[var(--color-ln-err)]" role="alert">
              {errors.locality}
            </p>
          ) : null}
        </div>

        <LnField label="Nombre y apellido" required error={errors.fullName}>
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              name={PILOT_FIELDS.fullName}
              defaultValue={kept(PILOT_FIELDS.fullName)}
              maxLength={PILOT_LIMITS.fullName}
              autoComplete="name"
              aria-describedby={describedBy}
              invalid={invalid}
              required
            />
          )}
        </LnField>

        <LnField label="Cargo" required error={errors.role}>
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              name={PILOT_FIELDS.role}
              defaultValue={kept(PILOT_FIELDS.role)}
              maxLength={PILOT_LIMITS.role}
              autoComplete="organization-title"
              aria-describedby={describedBy}
              invalid={invalid}
              required
            />
          )}
        </LnField>

        <LnField
          label="Correo institucional"
          hint="Te respondemos a esta dirección."
          required
          error={errors.email}
        >
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              name={PILOT_FIELDS.email}
              type="email"
              defaultValue={kept(PILOT_FIELDS.email)}
              maxLength={PILOT_LIMITS.email}
              autoComplete="email"
              aria-describedby={describedBy}
              invalid={invalid}
              required
            />
          )}
        </LnField>

        <LnField label="Teléfono" error={errors.phone}>
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              name={PILOT_FIELDS.phone}
              type="tel"
              defaultValue={kept(PILOT_FIELDS.phone)}
              maxLength={PILOT_LIMITS.phone}
              autoComplete="tel"
              aria-describedby={describedBy}
              invalid={invalid}
            />
          )}
        </LnField>
      </div>

      <LnField label="¿Qué te gustaría resolver?" error={errors.message} className="mt-5">
        {({ id, describedBy, invalid }) => (
          <LnTextarea
            id={id}
            name={PILOT_FIELDS.message}
            defaultValue={kept(PILOT_FIELDS.message)}
            maxLength={PILOT_LIMITS.message}
            rows={4}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      <div className="mt-5">
        <LnCheckbox
          name={PILOT_FIELDS.consent}
          defaultChecked={keptChecked(PILOT_FIELDS.consent, false)}
          key={`consent-${keptChecked(PILOT_FIELDS.consent, false)}`}
          invalid={Boolean(errors.consent)}
          required
        >
          Acepto que miMAR use estos datos solo para responder este mensaje. Viajan por correo a
          través de Resend, un proveedor de Estados Unidos, como explica la{" "}
          <Link href="/privacidad#proveedores" className="underline">
            política de privacidad
          </Link>
          .
        </LnCheckbox>
        {errors.consent ? (
          <p className="mt-1 font-ln-mono text-sm text-[var(--color-ln-err)]" role="alert">
            {errors.consent}
          </p>
        ) : null}
      </div>

      {failure ? <p className="lp-mun-failure mt-5">{failure}</p> : null}

      <LnButton type="submit" size="lg" loading={isPending} disabled={isPending} className="mt-5">
        {isPending ? "Enviando…" : "Enviar"}
      </LnButton>
    </form>
  );
}
