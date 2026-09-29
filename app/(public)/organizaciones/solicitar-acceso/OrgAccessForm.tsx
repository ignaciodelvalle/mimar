"use client";

// Organization access request form (critique 2026-09-29, M8). Posts to
// requestOrgAccessAction, which mails our general mailbox with Reply-To set to
// the requester. Nothing is stored. Rules and the copy of the refusals live in
// lib/outreach/org-access-request.ts; the shape mirrors the /municipios form
// (app/municipios/PilotRequestForm.tsx), including useKeptFields so a refusal
// does not wipe what the person typed.

import Link from "next/link";
import { useActionState, useState } from "react";

import { searchLocalitiesPublicAction } from "@/app/actions/localities";
import { LocalityPickerAcross } from "@/components/LocalityPickerAcross";
import { LnButton } from "@/components/ui/Button";
import { LnCheckbox, LnField, LnInput, LnSelect, LnTextarea } from "@/components/ui/Field";
import {
  ORG_ACCESS_FIELDS,
  ORG_ACCESS_INITIAL_STATE,
  ORG_ACCESS_LIMITS,
  ORG_TYPES,
  ORG_TYPE_LABELS,
  type OrgAccessFieldKey,
} from "@/lib/outreach/org-access-request";
import { PROVINCES } from "@/lib/reference/ar-provincias";
import { useKeptFields } from "@/lib/ui/use-kept-fields";

import { requestOrgAccessAction } from "./actions";

const ERROR_TEXT = "mt-1 font-ln-mono text-sm text-[var(--color-ln-err)]";

export function OrgAccessForm() {
  const { boundAction, kept, keptChecked } = useKeptFields(requestOrgAccessAction);
  const [state, formAction, isPending] = useActionState(boundAction, ORG_ACCESS_INITIAL_STATE);
  const [provinceCode, setProvinceCode] = useState("");

  const errors: Partial<Record<OrgAccessFieldKey, string>> =
    state.status === "invalid" ? state.fieldErrors : {};
  const failure =
    state.status === "rate_limited" || state.status === "unavailable" || state.status === "invalid"
      ? state.message
      : null;
  // One live region, mounted from the first render, for both outcomes.
  const announcement = state.status === "sent" ? "Recibimos tu pedido." : (failure ?? "");
  const province = provinceCode || kept(ORG_ACCESS_FIELDS.province);

  return (
    <>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {state.status === "sent" ? (
        <div
          className="rounded-xl border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-6 py-8"
          data-section="org-access-sent"
        >
          <h2 className="font-ln-serif text-2xl font-semibold text-[var(--color-ln-ink)]">
            Recibimos tu pedido.
          </h2>
          <p className="mt-2 text-md leading-relaxed text-[var(--color-ln-ink-2)]">
            Te escribimos al correo que dejaste para verificar la organización y darte acceso.
          </p>
        </div>
      ) : (
        <form action={formAction} className="space-y-5" noValidate>
          {/* Honeypot: invisible to people and to assistive tech, irresistible to bots. */}
          <div
            className="absolute h-px w-px overflow-hidden whitespace-nowrap [clip-path:inset(50%)]"
            aria-hidden="true"
          >
            <label>
              No completes este campo
              <input
                type="text"
                name={ORG_ACCESS_FIELDS.honeypot}
                tabIndex={-1}
                autoComplete="off"
                defaultValue={kept(ORG_ACCESS_FIELDS.honeypot)}
              />
            </label>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <LnField label="Tipo de organización" required error={errors.orgType}>
              {({ id, describedBy, invalid }) => (
                <LnSelect
                  id={id}
                  name={ORG_ACCESS_FIELDS.orgType}
                  key={`type-${kept(ORG_ACCESS_FIELDS.orgType)}`}
                  defaultValue={kept(ORG_ACCESS_FIELDS.orgType)}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  required
                >
                  <option value="">Elegí una opción</option>
                  {ORG_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {ORG_TYPE_LABELS[type]}
                    </option>
                  ))}
                </LnSelect>
              )}
            </LnField>

            <LnField label="Nombre de la organización" required error={errors.orgName}>
              {({ id, describedBy, invalid }) => (
                <LnInput
                  id={id}
                  name={ORG_ACCESS_FIELDS.orgName}
                  defaultValue={kept(ORG_ACCESS_FIELDS.orgName)}
                  maxLength={ORG_ACCESS_LIMITS.orgName}
                  autoComplete="organization"
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
                  name={ORG_ACCESS_FIELDS.province}
                  key={`province-${kept(ORG_ACCESS_FIELDS.province)}`}
                  defaultValue={kept(ORG_ACCESS_FIELDS.province)}
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
                htmlFor="org-access-locality-input"
                className="mb-1.5 flex items-center gap-1 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]"
              >
                Localidad
                <span className="text-[var(--color-ln-seal)]" aria-hidden="true">
                  *
                </span>
              </label>
              <LocalityPickerAcross
                // Remount on province change: a locality from the previous
                // province is never carried over.
                key={`locality-${province}`}
                id="org-access-locality"
                name={ORG_ACCESS_FIELDS.locality}
                scopeProvinceCode={province || null}
                disabled={!province}
                defaultValue={{
                  provinceCode: kept(ORG_ACCESS_FIELDS.province) || null,
                  localityName: kept(ORG_ACCESS_FIELDS.locality) || null,
                }}
                placeholder={province ? "Buscar localidad…" : "Primero elegí la provincia"}
                searchAction={searchLocalitiesPublicAction}
              />
              {errors.locality ? (
                <p className={ERROR_TEXT} role="alert">
                  {errors.locality}
                </p>
              ) : null}
            </div>

            <LnField label="Nombre y apellido" required error={errors.fullName}>
              {({ id, describedBy, invalid }) => (
                <LnInput
                  id={id}
                  name={ORG_ACCESS_FIELDS.fullName}
                  defaultValue={kept(ORG_ACCESS_FIELDS.fullName)}
                  maxLength={ORG_ACCESS_LIMITS.fullName}
                  autoComplete="name"
                  aria-describedby={describedBy}
                  invalid={invalid}
                  required
                />
              )}
            </LnField>

            <LnField
              label="Correo"
              hint="Te respondemos a esta dirección."
              required
              error={errors.email}
            >
              {({ id, describedBy, invalid }) => (
                <LnInput
                  id={id}
                  name={ORG_ACCESS_FIELDS.email}
                  type="email"
                  defaultValue={kept(ORG_ACCESS_FIELDS.email)}
                  maxLength={ORG_ACCESS_LIMITS.email}
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
                  name={ORG_ACCESS_FIELDS.phone}
                  type="tel"
                  defaultValue={kept(ORG_ACCESS_FIELDS.phone)}
                  maxLength={ORG_ACCESS_LIMITS.phone}
                  autoComplete="tel"
                  aria-describedby={describedBy}
                  invalid={invalid}
                />
              )}
            </LnField>
          </div>

          <LnField label="Contanos qué hacen" error={errors.message}>
            {({ id, describedBy, invalid }) => (
              <LnTextarea
                id={id}
                name={ORG_ACCESS_FIELDS.message}
                defaultValue={kept(ORG_ACCESS_FIELDS.message)}
                maxLength={ORG_ACCESS_LIMITS.message}
                rows={4}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>

          <div>
            <LnCheckbox
              name={ORG_ACCESS_FIELDS.consent}
              defaultChecked={keptChecked(ORG_ACCESS_FIELDS.consent, false)}
              key={`consent-${keptChecked(ORG_ACCESS_FIELDS.consent, false)}`}
              invalid={Boolean(errors.consent)}
              required
            >
              Acepto que miMAR use estos datos solo para responder este pedido. Viajan por correo a
              través de Resend, un proveedor de Estados Unidos, como explica la{" "}
              <Link href="/privacidad#proveedores" className="underline">
                política de privacidad
              </Link>
              .
            </LnCheckbox>
            {errors.consent ? (
              <p className={ERROR_TEXT} role="alert">
                {errors.consent}
              </p>
            ) : null}
          </div>

          {failure ? (
            <p className="m-0 rounded-[var(--radius-input)] border border-[var(--color-ln-err)] bg-[var(--color-ln-err-050)] px-3.5 py-2.5 text-base text-[var(--color-ln-err)]">
              {failure}
            </p>
          ) : null}

          <LnButton type="submit" size="lg" loading={isPending} disabled={isPending}>
            {isPending ? "Enviando…" : "Enviar pedido"}
          </LnButton>
        </form>
      )}
    </>
  );
}
