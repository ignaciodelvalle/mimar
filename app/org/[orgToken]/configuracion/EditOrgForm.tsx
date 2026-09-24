"use client";

import { useActionState, useState } from "react";

import { LnAlert } from "@/components/ui/Alert";
import { LnButton } from "@/components/ui/Button";
import { LnCheckbox, LnField, LnInput } from "@/components/ui/Field";
import { OpTextarea } from "@/components/ui/dashboard/OpField";
import type { Organization } from "@/db";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import {
  type UpdateOrgFormState,
  updateOrganizationAction,
} from "@/src/modules/organizations/actions";

// Shelter and rescue_network org types show the capacity section (Item 16 D1).
const SHELTER_TYPES = new Set<string>(["shelter", "rescue_network"]);

type Props = {
  organization: Pick<
    Organization,
    | "publicToken"
    | "displayName"
    | "legalName"
    | "email"
    | "phone"
    | "website"
    | "description"
    | "personeriaJuridicaNumber"
    | "tier0ShowOriginOrg"
    | "orgType"
    // Capacity columns (Item 16 D1, migration 0102).
    | "capacityDogs"
    | "capacityCats"
    | "capacityOther"
    | "capacityTotal"
  >;
};

const initialState: UpdateOrgFormState = { error: null };

function capacityStr(val: number | string | null | undefined): string {
  if (val === null || val === undefined) return "";
  return String(val);
}

export function EditOrgForm({ organization }: Props) {
  // forms/react19-reset-data-loss-inventory: "tier0ShowOriginOrg" has a
  // STATIC defaultChecked derived from `organization` — a rejected submit
  // puts back the ORIGINAL toggle state, discarding whatever the admin had
  // just changed it to.
  const { boundAction, keptChecked } = useKeptFields<UpdateOrgFormState>(updateOrganizationAction);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);

  // Controlled field state — preserves typed input on validation error.
  const [displayName, setDisplayName] = useState(organization.displayName);
  const [legalName, setLegalName] = useState(organization.legalName ?? "");
  const [email, setEmail] = useState(organization.email ?? "");
  const [phone, setPhone] = useState(organization.phone ?? "");
  const [website, setWebsite] = useState(organization.website ?? "");
  const [description, setDescription] = useState(organization.description ?? "");
  const [personeriaJuridicaNumber, setPersoneriaJuridicaNumber] = useState(
    organization.personeriaJuridicaNumber ?? "",
  );

  // Capacity fields (shelters only).
  const isShelter = SHELTER_TYPES.has(organization.orgType);
  const [capacityDogs, setCapacityDogs] = useState(capacityStr(organization.capacityDogs));
  const [capacityCats, setCapacityCats] = useState(capacityStr(organization.capacityCats));
  const [capacityOther, setCapacityOther] = useState(capacityStr(organization.capacityOther));
  const [capacityTotal, setCapacityTotal] = useState(capacityStr(organization.capacityTotal));

  return (
    <form action={formAction} className="space-y-5 max-w-xl">
      {/* Hidden field so the action knows which org to update */}
      <input type="hidden" name="orgToken" value={organization.publicToken} />

      <LnField label="Nombre público" required hint="Nombre que verán los demás usuarios de miMAR.">
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="displayName"
            type="text"
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      <LnField
        label="Razón social"
        hint="Nombre legal completo (ej: Asoc. Civil Refugio El Campito)."
      >
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="legalName"
            type="text"
            value={legalName}
            onChange={(e) => setLegalName(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      <LnField label="Correo electrónico de contacto">
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      <LnField label="Teléfono">
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      <LnField label="Sitio web" hint="Debe comenzar con http:// o https://">
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="website"
            type="url"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      <LnField label="Descripción pública" hint="Máximo 2000 caracteres.">
        {({ id, describedBy }) => (
          <OpTextarea
            id={id}
            name="description"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-describedby={describedBy}
            className="resize-y"
          />
        )}
      </LnField>

      <LnField label="Número de personería jurídica">
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="personeriaJuridicaNumber"
            type="text"
            value={personeriaJuridicaNumber}
            onChange={(e) => setPersoneriaJuridicaNumber(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      <div className="space-y-1">
        <LnCheckbox
          name="tier0ShowOriginOrg"
          value="true"
          defaultChecked={keptChecked(
            "tier0ShowOriginOrg",
            organization.tier0ShowOriginOrg,
            "true",
          )}
        >
          Mostrar a mi organización como refugio de origen en la credencial pública de las mascotas
        </LnCheckbox>
        <p className="text-sm text-ln-op-mute pl-6">
          Cuando está activo, la credencial pública muestra el nombre de tu organización como
          refugio de origen de la mascota.
        </p>
      </div>

      {/* Shelter capacity section (Item 16 D1) — only for shelter / rescue_network orgs */}
      {isShelter && (
        <fieldset className="space-y-4 rounded-[var(--radius-md)] border border-ln-op-line p-4">
          <legend className="px-1 text-md font-semibold text-ln-op-ink">Capacidad</legend>
          <p className="text-sm text-ln-op-mute -mt-2">
            Declarar la capacidad te permite calcular tu ocupación y recibir alertas cuando estés
            llegando al límite. Los campos son opcionales — podés completar solo los que
            correspondan.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <LnField label="Perros" hint="Capacidad máxima de perros.">
              {({ id, describedBy, invalid }) => (
                <LnInput
                  id={id}
                  name="capacityDogs"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={99999}
                  value={capacityDogs}
                  onChange={(e) => setCapacityDogs(e.target.value)}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  placeholder="—"
                />
              )}
            </LnField>

            <LnField label="Gatos" hint="Capacidad máxima de gatos.">
              {({ id, describedBy, invalid }) => (
                <LnInput
                  id={id}
                  name="capacityCats"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={99999}
                  value={capacityCats}
                  onChange={(e) => setCapacityCats(e.target.value)}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  placeholder="—"
                />
              )}
            </LnField>

            <LnField label="Otros" hint="Capacidad máxima de otras especies.">
              {({ id, describedBy, invalid }) => (
                <LnInput
                  id={id}
                  name="capacityOther"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={99999}
                  value={capacityOther}
                  onChange={(e) => setCapacityOther(e.target.value)}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  placeholder="—"
                />
              )}
            </LnField>

            <LnField label="Total" hint="Capacidad máxima total (todas las especies).">
              {({ id, describedBy, invalid }) => (
                <LnInput
                  id={id}
                  name="capacityTotal"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={99999}
                  value={capacityTotal}
                  onChange={(e) => setCapacityTotal(e.target.value)}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  placeholder="—"
                />
              )}
            </LnField>
          </div>
        </fieldset>
      )}

      {state.error && <LnAlert variant="danger">{state.error}</LnAlert>}
      {state.ok && <LnAlert variant="success">Cambios guardados correctamente.</LnAlert>}

      <LnButton type="submit" disabled={isPending}>
        {isPending ? "Guardando..." : "Guardar cambios"}
      </LnButton>
    </form>
  );
}
