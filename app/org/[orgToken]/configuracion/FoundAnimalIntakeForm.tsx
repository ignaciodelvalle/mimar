"use client";

// "Animales encontrados" — an org admin's opt-in to the finder's plan-B list
// (migration 0292, P4). Off by default. The org appears only while it is
// verified and active, and only with what is filled in HERE: the contact is a
// channel the org chooses to publish, never its account email or phone.
// Every change is audited by the table's trigger (before → after).

import { useActionState } from "react";

import { LnAlert } from "@/components/ui/Alert";
import { LnButton } from "@/components/ui/Button";
import { LnCheckbox, LnField, LnInput, LnRadio, LnSelect } from "@/components/ui/Field";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import {
  type FoundAnimalIntakeSettings,
  INTAKE_CAPACITY_LABELS,
  INTAKE_CAPACITY_STATUSES,
  INTAKE_CONFIRMATION_DAYS,
  INTAKE_CONTACT_KINDS,
  INTAKE_CONTACT_KIND_LABELS,
  INTAKE_CONTACT_MAX,
  INTAKE_HOURS_MAX,
} from "@/src/modules/organizations/domain/found-animal-intake";
import {
  type FoundAnimalIntakeFormState,
  updateFoundAnimalIntakeAction,
} from "@/src/modules/organizations/found-animal-actions";

const initialState: FoundAnimalIntakeFormState = { error: null };

export function FoundAnimalIntakeForm({
  orgToken,
  settings,
  verified,
  hasLocation,
  confirmationExpired = false,
}: {
  orgToken: string;
  settings: FoundAnimalIntakeSettings;
  verified: boolean;
  /** Whether the org has a pin or a catalogue locality to measure from. */
  hasLocation: boolean;
  /** "Recibimos" not confirmed in INTAKE_CONFIRMATION_DAYS: shown publicly as "Consultar antes". */
  confirmationExpired?: boolean;
}) {
  const { boundAction, kept, keptChecked } = useKeptFields<FoundAnimalIntakeFormState>(
    updateFoundAnimalIntakeAction,
  );
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  const keptContactKind = kept("publicContactKind", settings.publicContactKind ?? "");

  return (
    <form action={formAction} className="max-w-xl space-y-5" data-testid="found-animal-intake-form">
      <input type="hidden" name="orgToken" value={orgToken} />

      <div className="space-y-1">
        <LnCheckbox
          name="accepting"
          value="true"
          defaultChecked={keptChecked("accepting", settings.accepting, "true")}
        >
          Recibimos animales encontrados
        </LnCheckbox>
        <p className="pl-6 text-sm text-ln-op-mute">
          Quien encuentre un animal y no pueda tenerlo hasta que lo busque su familia va a ver tu
          organización en la lista de organizaciones cercanas que reciben. Primero siempre le
          mostramos cómo buscar a su familia.
        </p>
        {!verified && (
          <p className="pl-6 text-sm text-ln-op-mute">
            No vas a aparecer hasta que miMAR verifique la organización.
          </p>
        )}
        {!hasLocation && (
          <p className="pl-6 text-sm text-ln-op-mute">
            Tu organización no tiene ubicación cargada, así que no podemos calcular a qué distancia
            está. Pedile al equipo de miMAR que la complete.
          </p>
        )}
      </div>

      {confirmationExpired && !state.saved && (
        <LnAlert variant="warning">
          Hace más de {INTAKE_CONFIRMATION_DAYS} días que no confirmás que reciben animales, así que
          en la lista pública figura como “Consultar antes”. Revisá los datos y guardá para
          confirmarlo.
        </LnAlert>
      )}

      <fieldset className="space-y-2">
        <legend className="text-md font-semibold text-ln-op-ink">¿Tienen lugar ahora?</legend>
        {INTAKE_CAPACITY_STATUSES.map((status) => (
          <LnRadio
            key={status}
            name="capacityStatus"
            value={status}
            defaultChecked={keptChecked(
              "capacityStatus",
              settings.capacityStatus === status,
              status,
            )}
          >
            {INTAKE_CAPACITY_LABELS[status]}
          </LnRadio>
        ))}
      </fieldset>

      <fieldset className="space-y-3 rounded-[var(--radius-md)] border border-ln-op-line p-4">
        <legend className="px-1 text-md font-semibold text-ln-op-ink">
          Contacto público (opcional)
        </legend>
        <p className="-mt-1 text-sm text-ln-op-mute">
          Se publica tal cual lo escribas. Usá un canal de la organización, no uno personal.
        </p>
        <LnField label="Tipo de contacto">
          {({ id, describedBy, invalid }) => (
            <LnSelect
              // The key REMOUNTS the select when a submit settles with a new
              // value: only the mount path writes the `selected` attribute the
              // reset restores from (see useKeptFields).
              key={`contact-kind-${keptContactKind}`}
              id={id}
              name="publicContactKind"
              defaultValue={keptContactKind}
              aria-describedby={describedBy}
              invalid={invalid}
            >
              <option value="">Sin contacto publicado</option>
              {INTAKE_CONTACT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {INTAKE_CONTACT_KIND_LABELS[kind]}
                </option>
              ))}
            </LnSelect>
          )}
        </LnField>
        <LnField
          label="Dato de contacto"
          hint="Un teléfono o WhatsApp con código de área, un correo o una página que empiece con https://"
        >
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              name="publicContactValue"
              type="text"
              maxLength={INTAKE_CONTACT_MAX}
              defaultValue={kept("publicContactValue", settings.publicContactValue ?? "")}
              aria-describedby={describedBy}
              invalid={invalid}
            />
          )}
        </LnField>
      </fieldset>

      <LnField label="Horarios (opcional)" hint="Ej.: lunes a viernes de 10 a 17">
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="publicHours"
            type="text"
            maxLength={INTAKE_HOURS_MAX}
            defaultValue={kept("publicHours", settings.publicHours ?? "")}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      {state.error && <LnAlert variant="danger">{state.error}</LnAlert>}
      {state.saved && !state.error && (
        <LnAlert variant="success">
          {state.saved.accepting
            ? "Listo: tu organización figura como receptora de animales encontrados."
            : "Listo: tu organización no figura como receptora."}
        </LnAlert>
      )}

      <LnButton type="submit" disabled={isPending}>
        {isPending ? "Guardando..." : "Guardar recepción de animales"}
      </LnButton>
    </form>
  );
}
