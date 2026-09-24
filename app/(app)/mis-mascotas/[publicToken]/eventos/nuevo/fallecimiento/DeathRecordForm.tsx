"use client";

import { Icon } from "@/components/Icon";
import { DateInputAr } from "@/components/ui/DateInputAr";
import { LnCallout } from "@/components/ui/DocElements";
import {
  LN_CONTROL_MONO_CLASS,
  LnField,
  LnInput,
  LnRadio,
  LnSelect,
  LnTextarea,
} from "@/components/ui/Field";
import {
  LnSheetAccordion,
  LnSheetBody,
  LnSheetFooter,
  LnSheetHeader,
  LnSubCard,
} from "@/components/ui/Sheet";
import { isNonRecommendedDisposition } from "@/lib/domain/disposition";
import { diseasesForSpecies, findDisease } from "@/lib/reference/diseases";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useFormErrorFocus } from "@/lib/ui/use-form-error-focus";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { todayIsoInAr } from "@/lib/utils/format";
import type { EventFormState } from "@/src/modules/events/actions";
import { useActionState, useState } from "react";
import { AttachmentField } from "../AttachmentField";

const initialState: EventFormState = { error: null };
type FormAction = (prev: EventFormState, formData: FormData) => Promise<EventFormState>;
const FORM_ID = "death-record-form";

const facilityHints: Record<string, { label: string; placeholder: string }> = {
  cremation_collective: { label: "Crematorio", placeholder: "Nombre del crematorio" },
  cremation_individual_ashes: { label: "Crematorio", placeholder: "Nombre del crematorio" },
  authorized_cemetery: {
    label: "Cementerio",
    placeholder: "Nombre del cementerio o número de habilitación",
  },
  owner_burial: { label: "Ubicación (opcional)", placeholder: "Lugar del entierro" },
};

const defaultFacilityHint = { label: "Instalación", placeholder: "Veterinaria, crematorio, etc." };

/** Inline LN-styled checkbox */
function LnCheckbox({
  name,
  value,
  required,
  defaultChecked,
  onChange,
  children,
}: {
  name: string;
  value: string;
  required?: boolean;
  /**
   * DOM-OWNED, not `checked`. React 19 resets this form when the action
   * settles - including on an error - and a CONTROLLED checkbox comes back at
   * its mount value while React state still holds the real one. The attribute
   * is what a reset restores from, so the value has to live there.
   */
  defaultChecked?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        name={name}
        value={value}
        required={required}
        defaultChecked={defaultChecked}
        onChange={onChange}
        className="mt-0.5 h-[14px] w-[14px] flex-shrink-0 accent-[var(--color-ln-azul)]"
      />
      <span className="text-md text-[var(--color-ln-ink)]">{children}</span>
    </label>
  );
}

export function DeathRecordForm({
  action,
  species,
  defaults,
  inRabiesObservation = false,
}: {
  action: FormAction;
  species: string | null;
  defaults?: { occurredAt: string | null; notes: string | null };
  /** True when the pet has an active rabies observation (pets.rabiesObservationStatus). */
  inRabiesObservation?: boolean;
}) {
  // THE RESET HERE DOES NOT JUST LOSE WORK, IT CAN WRITE A FALSE FACT.
  //
  // React 19 resets a `<form action>` when the action settles, error included.
  // Controlled text survives; a controlled `<select>` and a controlled
  // checkbox do not - the reset restores them from the ATTRIBUTE, which only
  // react-dom's mount path writes. Measured in
  // `__tests__/react19-form-reset-contract.test.tsx`.
  //
  // On most forms that costs the person their typing. On THIS one it can cost
  // the truth: the person ticks "falleció en una veterinaria", the server
  // bounces the submit for an unrelated reason (there are six such branches in
  // `src/modules/events/actions.ts`), and the box comes back unticked while
  // everything around it still looks filled in. Re-submitting then records
  // that the animal did NOT die at a clinic. This form says out loud, a few
  // lines below, that the record "no se puede editar, corregir ni deshacer
  // después".
  //
  // WHEN THE DEPENDENT FIELDS ARE FILLED the server catches it instead, with
  // "Indicaste un nombre de clínica pero no marcaste que falleció en una
  // veterinaria" - an error about something the person DID tick, which is its
  // own kind of cruel. The silent branch is the one where those fields are
  // empty and nothing is left to cross-check.
  //
  // Every control below is DOM-owned now; the `useState` mirrors stay only
  // because the cross-field JSX reads them, and they were never what was lost.
  const { boundAction, kept, keptChecked } = useKeptFields(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  // N3 redirect contract: the action returns `redirectTo` on success and the
  // form performs the full document navigation (see lib/ui/use-action-redirect.ts).
  useActionRedirect(state.redirectTo, state);
  const errorRef = useFormErrorFocus<HTMLParagraphElement>(state.error);
  const { key: idempotencyKey } = useIdempotencyKey();
  const today = todayIsoInAr();
  const [cause, setCause] = useState("");
  const [selectedDiseaseCode, setSelectedDiseaseCode] = useState("");
  const [causeDetail, setCauseDetail] = useState("");
  const [vetName, setVetName] = useState("");
  const [disposition, setDisposition] = useState("");
  const [deathAtClinic, setDeathAtClinic] = useState(false);
  const [vetContactedOwner, setVetContactedOwner] = useState("");
  const [clinicName, setClinicName] = useState("");
  const [facility, setFacility] = useState("");
  // Plain const, not state: DateInputAr owns the field's value from here on
  // (it submits its own hidden ISO input), so nothing in this component reads
  // the date back — a mirrored copy would only be a second source of truth.
  const occurredAtDefault = defaults?.occurredAt ?? today;
  const [notes, setNotes] = useState(defaults?.notes ?? "");

  const diseaseOptions = diseasesForSpecies(species);
  const selectedDiseaseDef = findDisease(selectedDiseaseCode);
  const isReportableDisease = selectedDiseaseDef?.reportable === true;

  const facilityHint = facilityHints[disposition] ?? defaultFacilityHint;
  // Rabies-aware warning wins over the generic burial tips: telling someone
  // HOW to bury properly while telling them NOT to bury would contradict
  // itself, so the tips stay for the non-observed case only.
  const showRabiesDisposalWarning = inRabiesObservation && isNonRecommendedDisposition(disposition);
  const showOwnerBurialHint = disposition === "owner_burial" && !showRabiesDisposalWarning;
  const showVetDecidedAlone = deathAtClinic && vetContactedOwner === "no";

  return (
    <>
      <LnSheetHeader
        tone="seal"
        icon={<Icon name="fallecimiento" decorative />}
        title="Registrar fallecimiento"
        subtitle="Libreta sanitaria oficial"
      />
      <LnSheetBody>
        <form id={FORM_ID} action={formAction} className="contents">
          <input type="hidden" name="clientIdempotencyKey" value={idempotencyKey} />

          {/* Irreversibility notice, BEFORE the fields (2026-08-17).
              `death_recorded` is deliberately excluded from AMENDABLE_EVENT_TYPES
              in lib/infra/amendment.ts ("no reversal path; forensic"), and this
              route redirects away as soon as `pet.status === "deceased"` — so
              the owner cannot even return here to file a correction. Every other
              form in this folder writes an event the owner CAN amend later, and
              AmendEventForm explains the model well; this one had no warning at
              all, which meant the only irreversible act was the only one that
              never said so. Placed first, following the pattern the
              dangerous-breed attestation already uses. */}
          <div
            className="rounded-[var(--radius-sm)] border border-[var(--color-ln-warn)] px-4 py-3"
            role="note"
          >
            <p className="text-sm text-[var(--color-ln-warn)] leading-relaxed">
              Este registro cierra la libreta de la mascota y no se puede editar, corregir ni
              deshacer después — a diferencia de los demás registros sanitarios. Revisá la causa y
              la fecha antes de confirmar.
            </p>
          </div>

          <LnField label="Causa" required>
            {({ id, describedBy, invalid }) => (
              <LnSelect
                id={id}
                name="cause"
                required
                key={`cause-${kept("cause")}`}
                defaultValue={kept("cause")}
                onChange={(e) => {
                  setCause(e.target.value);
                  setSelectedDiseaseCode("");
                }}
                aria-describedby={describedBy}
                invalid={invalid}
              >
                <option value="">— Seleccioná —</option>
                <option value="known">Conocida</option>
                <option value="unknown">Desconocida</option>
                <option value="natural">Natural / vejez</option>
                <option value="disease">Enfermedad</option>
                <option value="accident">Accidente</option>
                <option value="euthanasia">Eutanasia</option>
                <option value="sudden">Repentina</option>
                <option value="violent">Violenta</option>
                <option value="other">Otra</option>
              </LnSelect>
            )}
          </LnField>

          {cause === "disease" && (
            <LnSubCard>
              <LnField label="Enfermedad" required>
                {({ id, describedBy, invalid }) => (
                  <LnSelect
                    id={id}
                    name="diseaseCode"
                    key={`diseaseCode-${kept("diseaseCode")}`}
                    defaultValue={kept("diseaseCode")}
                    onChange={(e) => setSelectedDiseaseCode(e.target.value)}
                    aria-describedby={describedBy}
                    invalid={invalid}
                  >
                    <option value="">Seleccionar enfermedad</option>
                    {diseaseOptions.map((d) => (
                      <option key={d.code} value={d.code}>
                        {d.label}
                      </option>
                    ))}
                  </LnSelect>
                )}
              </LnField>
              {isReportableDisease && (
                <LnCallout tone="warn">Reportable a autoridad sanitaria</LnCallout>
              )}
              <LnCheckbox
                name="confirmedByLab"
                value="true"
                defaultChecked={keptChecked("confirmedByLab", false)}
              >
                Confirmado por laboratorio
              </LnCheckbox>
            </LnSubCard>
          )}

          <LnField label="Detalles de la causa">
            {({ id, describedBy }) => (
              <LnTextarea
                id={id}
                name="causeDetail"
                rows={2}
                placeholder="Detalles, si querés agregar"
                value={causeDetail}
                onChange={(e) => setCauseDetail(e.target.value)}
                aria-describedby={describedBy}
              />
            )}
          </LnField>

          <LnCheckbox
            name="confirmedByVet"
            value="true"
            defaultChecked={keptChecked("confirmedByVet", false)}
          >
            Confirmado por veterinario/a
          </LnCheckbox>

          <LnField label="Nombre del veterinario/a">
            {({ id, describedBy }) => (
              <LnInput
                id={id}
                name="vetName"
                type="text"
                placeholder="Dra. López, Dr. García…"
                value={vetName}
                onChange={(e) => setVetName(e.target.value)}
                aria-describedby={describedBy}
              />
            )}
          </LnField>

          {/* Death at clinic section */}
          <LnSheetAccordion num="+" title="¿Falleció en una veterinaria?">
            <div className="flex flex-col gap-2.5">
              <LnCheckbox
                name="deathAtClinic"
                value="true"
                defaultChecked={keptChecked("deathAtClinic", false)}
                onChange={(e) => {
                  setDeathAtClinic(e.target.checked);
                  if (!e.target.checked) {
                    // `vetDecidedAlone` is NOT cleared here any more, and its
                    // absence is the point: the box lives inside
                    // `{showVetDecidedAlone && ...}`, so closing this gate
                    // UNMOUNTS it and the DOM forgets it. The old line existed
                    // because the box was controlled and React state outlives
                    // an unmount; DOM-owned, there is nothing left to clear.
                    setVetContactedOwner("");
                    setClinicName("");
                  }
                }}
              >
                Falleció durante una estadía en la veterinaria
              </LnCheckbox>

              {deathAtClinic && (
                <>
                  <LnField label="Nombre de la clínica">
                    {({ id, describedBy }) => (
                      <LnInput
                        id={id}
                        name="clinicName"
                        type="text"
                        placeholder="Clínica Veterinaria…"
                        value={clinicName}
                        onChange={(e) => setClinicName(e.target.value)}
                        aria-describedby={describedBy}
                      />
                    )}
                  </LnField>

                  <div className="flex flex-col gap-1.5">
                    <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]">
                      ¿El veterinario logró contactarte?
                    </p>
                    <div className="flex flex-col gap-1.5">
                      {[
                        { value: "yes", label: "Sí, me contactaron" },
                        { value: "no", label: "No, no lograron contactarme" },
                        { value: "not_applicable", label: "No aplica" },
                      ].map((opt) => (
                        <LnRadio
                          key={opt.value}
                          name="vetContactedOwner"
                          value={opt.value}
                          defaultChecked={keptChecked("vetContactedOwner", false, opt.value)}
                          onChange={(e) => setVetContactedOwner(e.target.value)}
                        >
                          {opt.label}
                        </LnRadio>
                      ))}
                    </div>
                  </div>

                  {showVetDecidedAlone && (
                    <LnCheckbox
                      name="vetDecidedAlone"
                      value="true"
                      defaultChecked={keptChecked("vetDecidedAlone", false)}
                    >
                      El veterinario decidió la disposición sin poder contactarme
                    </LnCheckbox>
                  )}
                </>
              )}
            </div>
          </LnSheetAccordion>

          <LnCheckbox
            name="ownerToPrivateCrematorium"
            value="true"
            defaultChecked={keptChecked("ownerToPrivateCrematorium", false)}
          >
            Llevé el cuerpo a un crematorio privado por mi cuenta
          </LnCheckbox>

          <LnField label="Método de disposición">
            {({ id, describedBy, invalid }) => (
              <LnSelect
                id={id}
                name="dispositionMethod"
                key={`dispositionMethod-${kept("dispositionMethod")}`}
                defaultValue={kept("dispositionMethod")}
                onChange={(e) => setDisposition(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              >
                <option value="">—</option>
                <optgroup label="Recomendadas">
                  <option value="cremation_collective">Cremación colectiva</option>
                  <option value="cremation_individual_ashes">
                    Cremación individual (cenizas al propietario)
                  </option>
                  <option value="authorized_cemetery">Cementerio de animales autorizado</option>
                </optgroup>
                <optgroup label="No recomendadas">
                  <option value="owner_burial">Sepultura por el propietario</option>
                  <option value="household_waste">Residuos no especiales (basura)</option>
                </optgroup>
                <optgroup label="Otras">
                  <option value="rendering">Reciclaje sanitario</option>
                  <option value="unknown">No sé</option>
                </optgroup>
              </LnSelect>
            )}
          </LnField>

          {showRabiesDisposalWarning && (
            // Legal anchors per lib/reference/legal-knowledge-base.ts: the
            // national anti-rabies framework (Ley 22.953/1983) and, for CABA,
            // the regulated cremation process (Ley 5470/2015). The warning
            // never blocks submission — the record reflects reality, and the
            // server cascade already notifies the sanitary authority.
            <LnCallout tone="danger" title="Tu mascota está en observación antirrábica">
              Durante el período de observación antirrábica (Ley Nacional 22.953), la disposición
              del cuerpo debe hacerse por canales autorizados —cremación en un establecimiento
              habilitado o cementerio autorizado (en CABA lo regula la Ley 5470/2015)— para que la
              autoridad sanitaria pueda descartar rabia. El método que elegiste no pasa por esos
              canales. Podés registrarlo igual: la libreta refleja lo que pasó, y el sistema da
              aviso a la autoridad sanitaria correspondiente.
            </LnCallout>
          )}

          {showOwnerBurialHint && (
            <LnCallout tone="warn">
              <strong className="block">Si vas a enterrarlo, te recomendamos:</strong>
              <ul className="mt-1.5 list-inside list-disc space-y-[3px]">
                <li>Profundidad suficiente para que ningún carroñero pueda excavar.</li>
                <li>
                  Asegurate que el animal no tenía enfermedades zoonóticas o contagiosas a otros
                  animales.
                </li>
                <li>Que no haya acuíferos cerca que se puedan contaminar.</li>
                <li>Elegí una zona remota.</li>
              </ul>
            </LnCallout>
          )}

          <LnField label={facilityHint.label}>
            {({ id, describedBy }) => (
              <LnInput
                id={id}
                name="facility"
                type="text"
                placeholder={facilityHint.placeholder}
                value={facility}
                onChange={(e) => setFacility(e.target.value)}
                aria-describedby={describedBy}
              />
            )}
          </LnField>

          {/* Date of death is entered as an AUTHOR-OWNED dd/mm/aaaa field, not a
              native `<input type="date">`, whose visible text follows the
              BROWSER's locale — a viewer on an en-US machine was offered
              month/day order on the one field that fixes WHEN a pet died, and
              every date the libreta renders back is dd/mm/aaaa. DateInputAr is
              a drop-in here (not a composed pair like PetSightingForm's
              date+time): its own hidden input carries `occurredAt` with the
              same ISO yyyy-mm-dd the action already parses via parseDateInput,
              so the server is untouched. `required` is passed explicitly rather
              than left to LnField's aria injection: LnField clones
              `aria-required` onto the control it renders, but this control is a
              COMPONENT, not a DOM node — the cloned attribute would land on a
              prop DateInputAr does not read. Its own `required` puts the native
              constraint (and the es-AR bubble) on the visible input instead.
              `aria-invalid` used to have the same problem and no longer does:
              DateInputAr accepts the hyphenated prop and merges it with its own
              inline invalid-date state, so the render prop's `invalid` is wired
              through explicitly here rather than relying on LnField's clone. */}
          <LnField label="Fecha" required>
            {({ id, describedBy, invalid }) => (
              <DateInputAr
                id={id}
                name="occurredAt"
                defaultValue={occurredAtDefault}
                required
                ariaDescribedBy={describedBy}
                aria-invalid={invalid}
                className={LN_CONTROL_MONO_CLASS}
              />
            )}
          </LnField>
          <LnField label="Notas">
            {({ id, describedBy }) => (
              <LnTextarea
                id={id}
                name="notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                aria-describedby={describedBy}
              />
            )}
          </LnField>
          <AttachmentField />
          {state.error && (
            <p
              ref={errorRef}
              className="font-ln-mono text-sm text-[var(--color-ln-err)]"
              role="alert"
              tabIndex={-1}
            >
              {state.error}
            </p>
          )}
        </form>
      </LnSheetBody>
      <LnSheetFooter
        tone="seal"
        ctaLabel="Registrar fallecimiento"
        formId={FORM_ID}
        isPending={isPending}
      />
    </>
  );
}
