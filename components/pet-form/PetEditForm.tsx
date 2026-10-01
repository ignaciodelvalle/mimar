"use client";

// "Editar datos" on the web, by section (owner-pet-actions, PO 2026-10-01).
//
// THE APP'S SIX SECTIONS, IN THE APP'S ORDER — Identidad, Salud y cuidados,
// Contactos, Qué muestra la credencial pública, Seguro, Origen — read from the
// contract (`PET_PROFILE_EDIT_SECTIONS`), each with its own Guardar and a
// `seccion-<id>` anchor a link can land on. Two web-only blocks bracket them:
// the photo first and "Otros datos" last — the weight, the locality and the
// microchip. Each has a door of its own as well (the photo's `?sheet=foto`, the
// app's photo screen's twin; Anotar → Peso, the mudanza, Anotar → microchip)
// and still rides this form because its writer stores every column.
//
// EVERY GUARDAR SAVES THE WHOLE FORM. `updatePetAction` writes the whole row,
// so a post that left a field out would wipe it. The button a person pressed
// decides where they are told what happened — a refusal lands in that section
// — not what is written.
//
// RESET-SAFE, like the form it replaces: every field is controlled state, or a
// <select> keyed on state, so React 19's post-error form reset cannot fall a
// field back to its first option.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useActionState, useEffect, useMemo, useRef, useState } from "react";

import { SheetTriggerLink } from "@/components/pet-profile/SheetTriggerLink";
import { LnButton } from "@/components/ui/Button";
import { LnChipGroup } from "@/components/ui/Chip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LnCallout } from "@/components/ui/DocElements";
import { LnField, LnInput, LnSelect } from "@/components/ui/Field";
import type { Pet } from "@/db";
import { provinceByName } from "@/lib/reference/ar-provincias";
import {
  breedListIncludes,
  breedsForSpecies,
  isPotentiallyDangerousBreed,
  resolveBreedLabel,
} from "@/lib/reference/breeds";
import {
  COMMON_ALLERGIES,
  COMMON_FOODS,
  INSURANCE_COMPANIES,
  TRAINING_LEVELS,
} from "@/lib/reference/lookups";
import {
  PERMANENT_CONDITIONS,
  type PermanentCondition,
} from "@/lib/reference/permanent-conditions";
import { scrollIntoViewRespectingMotion } from "@/lib/ui/reduced-motion-scroll";
import { isSameRouteUrl } from "@/lib/ui/sheet-nav";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { speciesLabel } from "@/lib/utils/format";
import type { NewPetFormState } from "@/src/modules/pets/domain/types";
import {
  PET_CONDITION_OTHER_MAX,
  PET_INSURANCE_COMPANY_MAX,
  PET_INSURANCE_POLICY_MAX,
  petIdentityFieldCap,
} from "@dim/contract/input";
import {
  LOCALITY_FIELD_LABEL,
  PET_ACTION_COPY,
  PET_ACTION_INERT_CAPTIONS,
  type PetProfileEditSectionId,
  petAgeFromBirthDate,
  petProfileEditSection,
  pluralizeEs,
} from "@dim/contract/reference";

import {
  ConditionOtherField,
  type ExistingCanonicalChip,
  LnAgeFields,
  LnPhotoField,
  LnReadOnlyField,
  MicrochipBlock,
  PermanentConditionChips,
  PublicDisclosureToggles,
} from "./fields";

type FormAction = (prev: NewPetFormState, formData: FormData) => Promise<NewPetFormState>;

const initialState: NewPetFormState = { error: null };

/** The two web-only blocks around the shared six. */
type WebSectionId = PetProfileEditSectionId | "foto" | "otros";

type Props = {
  action: FormAction;
  existingPet: Pet;
  existingPhotoUrl: string | null;
  existingCanonicalChip: ExistingCanonicalChip | null;
  pppBreedList?: readonly string[];
  /** The emergency-contacts sheet, or `null` when this viewer may not edit them. */
  contactsHref: string | null;
  /** The `seccion` a link landed on, scrolled into view on open. */
  initialSection: string | null;
};

/** What every section's Guardar needs from the form around it. */
type SaveState = {
  pending: boolean;
  /** The section whose Guardar was pressed last, and the refusal it got. */
  saving: WebSectionId | null;
  error: string | null;
  onSave: (id: WebSectionId) => void;
};

export function PetEditForm({
  action,
  existingPet,
  existingPhotoUrl,
  existingCanonicalChip,
  pppBreedList,
  contactsHref,
  initialSection,
}: Props) {
  // `sex` is a <select> whose value a person picks and a refused save must not
  // reset: the same kept-field hook the create form uses.
  const { boundAction, kept } = useKeptFields<NewPetFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  // N3: the action returns where to go; this navigates (see the create form).
  useActionRedirect(state.redirectTo, state);
  const [saving, setSaving] = useState<WebSectionId | null>(null);

  useEffect(() => {
    if (!initialSection) return;
    const target = document.getElementById(`seccion-${initialSection}`);
    if (target) scrollIntoViewRespectingMotion(target, { block: "start" });
  }, [initialSection]);

  const save: SaveState = {
    pending: isPending,
    saving,
    // Shown once the save has answered, in the section that asked.
    error: isPending ? null : state.error,
    onSave: setSaving,
  };
  const [conditions, setConditions] = useState<Set<PermanentCondition>>(
    () => new Set(knownConditions(existingPet.permanentConditions)),
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {/* FULL-LOCK: the species is read-only here; the hidden input carries it
          so the parser validates the unchanged value. */}
      <input type="hidden" name="species" value={existingPet.species} />
      <PhotoSection existingPhotoUrl={existingPhotoUrl} save={save} />
      <IdentitySection
        pet={existingPet}
        pppBreedList={pppBreedList}
        sexDefault={kept("sex", existingPet.sex ?? "unknown")}
        sexKey={kept("sex")}
        save={save}
      />
      <HealthSection
        pet={existingPet}
        conditions={conditions}
        onConditionsChange={setConditions}
        save={save}
      />
      <ContactsSection href={contactsHref} />
      <PublicCredentialSection pet={existingPet} hasConditions={conditions.size > 0} save={save} />
      <InsuranceSection pet={existingPet} save={save} />
      <OriginSection pet={existingPet} save={save} />
      <OtherDataSection
        pet={existingPet}
        existingCanonicalChip={existingCanonicalChip}
        save={save}
      />
      {/* A refusal from a submit no section claimed (Enter in a field). */}
      {save.error && save.saving === null ? (
        <p role="alert" className="font-ln-mono text-sm text-[var(--color-ln-err)]">
          {save.error}
        </p>
      ) : null}
    </form>
  );
}

/** The codes the catalog still names; the web's parser drops any other. */
function knownConditions(stored: readonly string[] | null): PermanentCondition[] {
  return (stored ?? []).filter((c): c is PermanentCondition =>
    (PERMANENT_CONDITIONS as readonly string[]).includes(c),
  );
}

// ---------------------------------------------------------------------------
// The section frame
// ---------------------------------------------------------------------------

function EditSection({
  id,
  title,
  saveLabel,
  save,
  children,
}: {
  id: WebSectionId;
  title: string;
  /** `null` = a section with no fields of this form (Contactos). */
  saveLabel: string | null;
  save: SaveState | null;
  children: ReactNode;
}) {
  const mine = save !== null && save.saving === id;
  return (
    <section
      id={`seccion-${id}`}
      aria-labelledby={`seccion-${id}-titulo`}
      className="flex scroll-mt-4 flex-col gap-2.5 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-3.5"
    >
      <h3
        id={`seccion-${id}-titulo`}
        className="font-ln-mono text-xs font-semibold uppercase tracking-[.12em] text-[var(--color-ln-mute)]"
      >
        {title}
      </h3>
      {children}
      {mine && save.error ? (
        <p role="alert" className="font-ln-mono text-sm text-[var(--color-ln-err)]">
          {save.error}
        </p>
      ) : null}
      {saveLabel && save ? (
        <LnButton
          type="submit"
          variant="primary"
          className="self-start"
          loading={save.pending && mine}
          disabled={save.pending}
          onClick={() => save.onSave(id)}
        >
          {saveLabel}
        </LnButton>
      ) : null}
    </section>
  );
}

/** A shared section's frame, titled and labelled from the contract. */
function SharedSection({
  id,
  save,
  children,
}: {
  id: PetProfileEditSectionId;
  save: SaveState | null;
  children: ReactNode;
}) {
  const section = petProfileEditSection(id);
  return (
    <EditSection id={id} title={section.title} saveLabel={section.saveLabel} save={save}>
      {children}
    </EditSection>
  );
}

// ---------------------------------------------------------------------------
// Foto (web-only here; the panel's "Foto" opens its own door, `?sheet=foto`)
// ---------------------------------------------------------------------------

function PhotoSection({
  existingPhotoUrl,
  save,
}: {
  existingPhotoUrl: string | null;
  save: SaveState;
}) {
  const [preview, setPreview] = useState<string | null>(existingPhotoUrl);
  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (preview?.startsWith("blob:")) URL.revokeObjectURL(preview);
    setPreview(file ? URL.createObjectURL(file) : existingPhotoUrl);
  }
  return (
    <EditSection id="foto" title={PET_ACTION_COPY.photo.label} saveLabel="Guardar foto" save={save}>
      <LnPhotoField onFileChange={onFileChange} preview={preview} />
    </EditSection>
  );
}

// ---------------------------------------------------------------------------
// Identidad
// ---------------------------------------------------------------------------

function IdentitySection({
  pet,
  pppBreedList,
  sexDefault,
  sexKey,
  save,
}: {
  pet: Pet;
  pppBreedList?: readonly string[];
  sexDefault: string;
  sexKey: string;
  save: SaveState;
}) {
  const [name, setName] = useState(pet.name ?? "");
  const [color, setColor] = useState(pet.color ?? "");
  // On Argentina's calendar, the same reading the server compares a posted age
  // against (`resolveEditedBirthDate`): a browser in another zone, or past
  // midnight UTC, must not show an age the stored date does not read as.
  const age = useMemo(
    () => petAgeFromBirthDate(pet.dateOfBirth ?? null, new Date()),
    [pet.dateOfBirth],
  );
  return (
    <SharedSection id="identidad" save={save}>
      <LnField label="Nombre" required>
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="name"
            type="text"
            required
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>
      <LnReadOnlyField
        label="Especie"
        value={speciesLabel(pet.species)}
        hint="La especie queda fija para no romper las reglas PPP y de compatibilidad."
        action={
          <a
            href={`/mis-mascotas/${pet.publicToken}/corregir-especie`}
            className="font-ln-mono text-sm tracking-[.04em] text-[var(--color-ln-azul)] underline underline-offset-2"
          >
            ¿Especie incorrecta?
          </a>
        }
      />
      <BreedField species={pet.species} stored={pet.breed ?? ""} pppBreedList={pppBreedList} />
      <LnField label="Sexo" required>
        {({ id, describedBy, invalid }) => (
          <LnSelect
            id={id}
            name="sex"
            key={`sex-${sexKey}`}
            required
            defaultValue={sexDefault}
            aria-describedby={describedBy}
            invalid={invalid}
          >
            <option value="unknown">No sé</option>
            <option value="male">Macho</option>
            <option value="female">Hembra</option>
          </LnSelect>
        )}
      </LnField>
      <LnAgeFields defaultYears={age.years} defaultMonths={age.months} />
      <LnField label="Color / marcas">
        {({ id, describedBy }) => (
          <LnInput
            id={id}
            name="color"
            type="text"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            aria-describedby={describedBy}
          />
        )}
      </LnField>
    </SharedSection>
  );
}

/**
 * The breed, from the species' catalog. A stored breed the catalog does not
 * carry is appended as its own option so the select never blanks — and the
 * next save never wipes — a recorded value (QA A5).
 */
function BreedField({
  species,
  stored,
  pppBreedList,
}: {
  species: string;
  stored: string;
  pppBreedList?: readonly string[];
}) {
  const [breed, setBreed] = useState(stored);
  const options = useMemo(() => {
    const catalog = breedsForSpecies(species);
    const current = breed.trim();
    return current && !catalog.includes(current) ? [...catalog, current] : catalog;
  }, [species, breed]);
  // Display-only: the server classifies on save. Normalised comparison, the
  // same the server runs, so the warning cannot disagree with the regime.
  const dangerous = useMemo(() => {
    const trimmed = breed.trim();
    if (species !== "dog" || !trimmed) return false;
    const resolved = resolveBreedLabel(trimmed) ?? trimmed;
    if (pppBreedList) return breedListIncludes(pppBreedList, resolved);
    return isPotentiallyDangerousBreed(species, breed);
  }, [species, breed, pppBreedList]);
  return (
    <>
      <LnField
        label="Raza"
        hint={
          species === "dog"
            ? "En perros, la raza y el peso definen si entra en el régimen PPP."
            : undefined
        }
      >
        {({ id, describedBy }) => (
          <LnSelect
            id={id}
            name="breed"
            key={`breed-${breed}`}
            defaultValue={breed}
            onChange={(e) => setBreed(e.target.value)}
            aria-describedby={describedBy}
          >
            <option value="">Elegí una raza…</option>
            {options.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </LnSelect>
        )}
      </LnField>
      {dangerous && (
        <LnCallout tone="warn" title="Raza potencialmente peligrosa">
          Esta raza está en el registro de razas potencialmente peligrosas (CABA: Ley 4078 · PBA:
          Ley 14.107). Registrate en el registro provincial correspondiente.
        </LnCallout>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Salud y cuidados
// ---------------------------------------------------------------------------

function HealthSection({
  pet,
  conditions,
  onConditionsChange,
  save,
}: {
  pet: Pet;
  conditions: Set<PermanentCondition>;
  onConditionsChange: (next: Set<PermanentCondition>) => void;
  save: SaveState;
}) {
  const [trainingLevel, setTrainingLevel] = useState(pet.trainingLevel ?? "");
  return (
    <SharedSection id="salud" save={save}>
      <ChipListField
        field="knownAllergies"
        title="Alergias conocidas"
        catalog={COMMON_ALLERGIES}
        stored={pet.knownAllergies ?? []}
        tone="rojo"
        otherLabel="Otras alergias conocidas (separadas por coma)"
      />
      <ChipListField
        field="favouriteFoods"
        title="Comidas favoritas"
        catalog={COMMON_FOODS}
        stored={pet.favouriteFoods ?? []}
        otherLabel="Otras comidas favoritas (separadas por coma)"
      />
      <LnField label="Nivel de entrenamiento">
        {({ id, describedBy, invalid }) => (
          <LnSelect
            id={id}
            name="trainingLevel"
            key={`trainingLevel-${trainingLevel}`}
            defaultValue={trainingLevel}
            onChange={(e) => setTrainingLevel(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          >
            <option value="">No especificar</option>
            {TRAINING_LEVELS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </LnSelect>
        )}
      </LnField>
      <ConditionsField
        stored={pet.permanentConditionsOther ?? ""}
        conditions={conditions}
        onConditionsChange={onConditionsChange}
      />
    </SharedSection>
  );
}

/**
 * A catalog of chips plus a free-text "otros", posted as one list. Both halves
 * are controlled state, so a refused save keeps what was picked and typed.
 */
function ChipListField({
  field,
  title,
  catalog,
  stored,
  tone,
  otherLabel,
}: {
  field: "knownAllergies" | "favouriteFoods";
  title: string;
  catalog: readonly string[];
  stored: readonly string[];
  tone?: "rojo";
  otherLabel: string;
}) {
  const [selected, setSelected] = useState<string[]>([...stored]);
  const [other, setOther] = useState(stored.filter((v) => !catalog.includes(v)).join(", "));
  return (
    <div className="flex flex-col gap-1.5">
      <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.12em] text-[var(--color-ln-faint)]">
        {title}
      </p>
      {selected.map((value) => (
        <input key={value} type="hidden" name={field} value={value} />
      ))}
      <LnChipGroup
        items={catalog.map((value) =>
          tone ? { key: value, label: value, tone } : { key: value, label: value },
        )}
        selected={selected}
        onChange={setSelected}
      />
      <LnInput
        name={`${field}Other`}
        type="text"
        placeholder="Otros (separá por coma si querés varios)"
        aria-label={otherLabel}
        value={other}
        onChange={(e) => setOther(e.target.value)}
      />
    </div>
  );
}

/**
 * The permanent conditions, behind the same confirm the create form has: a
 * health condition for life is not something to change by a stray tap.
 */
function ConditionsField({
  stored,
  conditions,
  onConditionsChange,
}: {
  stored: string;
  conditions: Set<PermanentCondition>;
  onConditionsChange: (next: Set<PermanentCondition>) => void;
}) {
  const [other, setOther] = useState(stored);
  const [unlocked, setUnlocked] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Where focus returns when the confirm closes: the button that opened it.
  const trigger = useRef<HTMLElement | null>(null);
  function toggle(code: PermanentCondition) {
    const next = new Set(conditions);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onConditionsChange(next);
  }
  return (
    <div className="flex flex-col gap-2.5 border-t border-[var(--color-ln-line-2)] pt-3">
      <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.12em] text-[var(--color-ln-faint)]">
        Condiciones permanentes
      </p>
      {/* Always posted, so a locked section keeps what is stored. */}
      <input type="hidden" name="permanentConditions" value={Array.from(conditions).join(",")} />
      {!conditions.has("otra") && <input type="hidden" name="permanentConditionsOther" value="" />}
      {unlocked ? (
        <>
          <PermanentConditionChips conditions={conditions} onToggle={toggle} />
          {conditions.has("otra") && (
            <ConditionOtherField
              value={other}
              onChange={setOther}
              maxLength={petIdentityFieldCap(PET_CONDITION_OTHER_MAX, stored)}
            />
          )}
        </>
      ) : (
        <>
          {conditions.size > 0 && (
            <p className="text-sm text-[var(--color-ln-mute)]">
              {conditions.size}{" "}
              {pluralizeEs(conditions.size, "condición registrada", "condiciones registradas")}.
            </p>
          )}
          {conditions.has("otra") && (
            <input type="hidden" name="permanentConditionsOther" value={other} />
          )}
          <LnButton
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={(e) => {
              trigger.current = e.currentTarget;
              setConfirming(true);
            }}
          >
            Editar condiciones permanentes
          </LnButton>
        </>
      )}
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => {
          setUnlocked(true);
          setConfirming(false);
        }}
        title="Editar condiciones permanentes"
        description="Vas a editar condiciones de salud permanentes (como amputaciones o epilepsia). Asegurate de que la información sea correcta antes de guardar."
        confirmLabel="Entendido, editar"
        cancelLabel="Cancelar"
        tone="warn"
        triggerRef={trigger}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contactos — a door to its own sheet, not fields of this form
// ---------------------------------------------------------------------------

function ContactsSection({ href }: { href: string | null }) {
  const pathname = usePathname();
  const copy = PET_ACTION_COPY.contacts;
  const linkClass =
    "self-start font-ln-mono text-sm tracking-[.04em] text-[var(--color-ln-azul)] underline underline-offset-2";
  let door: ReactNode;
  if (href === null) {
    door = (
      <p aria-disabled="true" className="text-sm text-[var(--color-ln-mute)]">
        {copy.label} · {PET_ACTION_INERT_CAPTIONS.titular_only}
      </p>
    );
  } else if (pathname !== null && isSameRouteUrl(pathname, href)) {
    // Same page: the sheet opens through the History API, never the router.
    door = (
      <SheetTriggerLink href={href} className={linkClass}>
        {copy.label}
      </SheetTriggerLink>
    );
  } else {
    door = (
      <Link href={href} className={linkClass}>
        {copy.label}
      </Link>
    );
  }
  return (
    <SharedSection id="contactos" save={null}>
      <p className="text-sm text-[var(--color-ln-ink-2)]">{copy.hint}</p>
      {door}
    </SharedSection>
  );
}

// ---------------------------------------------------------------------------
// Qué muestra la credencial pública
// ---------------------------------------------------------------------------

function PublicCredentialSection({
  pet,
  hasConditions,
  save,
}: {
  pet: Pet;
  hasConditions: boolean;
  save: SaveState;
}) {
  const [disclose, setDisclose] = useState(pet.discloseConditionsPublicly ?? false);
  const [emergency, setEmergency] = useState(pet.emergencyInfoVisible ?? false);
  return (
    <SharedSection id="credencial-publica" save={save}>
      <input type="hidden" name="discloseConditionsPublicly" value={disclose ? "true" : ""} />
      <input type="hidden" name="emergencyInfoVisible" value={emergency ? "true" : ""} />
      <PublicDisclosureToggles
        discloseConditions={disclose}
        emergencyInfoVisible={emergency}
        onDiscloseChange={setDisclose}
        onEmergencyChange={setEmergency}
      />
      {!hasConditions && (
        // The server turns disclosure off when there is nothing to disclose
        // (`normalizeDisclose`); saying so beats a switch that silently resets.
        <p className="text-sm text-[var(--color-ln-mute)]">
          Las condiciones se muestran solo si cargaste alguna en Salud y cuidados.
        </p>
      )}
    </SharedSection>
  );
}

// ---------------------------------------------------------------------------
// Seguro
// ---------------------------------------------------------------------------

function InsuranceSection({ pet, save }: { pet: Pet; save: SaveState }) {
  const [company, setCompany] = useState(pet.insuranceCompany ?? "");
  const [policy, setPolicy] = useState(pet.insurancePolicyNumber ?? "");
  return (
    <SharedSection id="seguro" save={save}>
      <LnField label="Compañía">
        {({ id, describedBy }) => (
          <LnInput
            id={id}
            name="insuranceCompany"
            type="text"
            list="insurance-companies"
            placeholder="Buscar o tipear…"
            maxLength={petIdentityFieldCap(PET_INSURANCE_COMPANY_MAX, pet.insuranceCompany)}
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            aria-describedby={describedBy}
          />
        )}
      </LnField>
      <datalist id="insurance-companies">
        {INSURANCE_COMPANIES.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <LnField label="Número de póliza">
        {({ id, describedBy }) => (
          <LnInput
            id={id}
            name="insurancePolicyNumber"
            type="text"
            mono
            maxLength={petIdentityFieldCap(PET_INSURANCE_POLICY_MAX, pet.insurancePolicyNumber)}
            value={policy}
            onChange={(e) => setPolicy(e.target.value)}
            aria-describedby={describedBy}
          />
        )}
      </LnField>
    </SharedSection>
  );
}

// ---------------------------------------------------------------------------
// Origen
// ---------------------------------------------------------------------------

function OriginSection({ pet, save }: { pet: Pet; save: SaveState }) {
  const [method, setMethod] = useState(pet.acquisitionMethod ?? "");
  return (
    <SharedSection id="origen" save={save}>
      <LnField label={`¿Cómo llegó ${pet.name}?`}>
        {({ id, describedBy, invalid }) => (
          <LnSelect
            id={id}
            name="acquisitionMethod"
            key={`acquisitionMethod-${method}`}
            defaultValue={method}
            onChange={(e) => setMethod(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          >
            <option value="">No especificar</option>
            <option value="adopted">Adoptado/a</option>
            <option value="purchased">Comprado/a</option>
            <option value="found_stray">Encontrado/a en la calle</option>
            <option value="gift">Regalado/a</option>
            <option value="born_in_litter">Nacido/a en casa (camada propia)</option>
            <option value="other">Otro</option>
          </LnSelect>
        )}
      </LnField>
    </SharedSection>
  );
}

// ---------------------------------------------------------------------------
// Otros datos (web-only: fields with their own doors that this form still carries)
// ---------------------------------------------------------------------------

function OtherDataSection({
  pet,
  existingCanonicalChip,
  save,
}: {
  pet: Pet;
  existingCanonicalChip: ExistingCanonicalChip | null;
  save: SaveState;
}) {
  const [weight, setWeight] = useState(
    pet.estimatedWeightKg != null ? String(pet.estimatedWeightKg) : "",
  );
  return (
    <EditSection id="otros" title="Otros datos" saveLabel="Guardar otros datos" save={save}>
      <LnField
        label="Peso estimado"
        hint={
          pet.species === "dog"
            ? "En kilogramos. Junto con la raza, define el régimen PPP."
            : "En kilogramos."
        }
      >
        {({ id, describedBy }) => (
          <LnInput
            id={id}
            name="estimatedWeightKg"
            type="number"
            step="0.1"
            min="0"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            aria-describedby={describedBy}
          />
        )}
      </LnField>
      {/* FULL-LOCK (PO decision #40): the locality moves only with a mudanza.
          Hidden inputs so the parser validates the unchanged value. */}
      <LnReadOnlyField
        label={LOCALITY_FIELD_LABEL}
        value={
          [pet.jurisdictionLocality, pet.jurisdictionProvince].filter(Boolean).join(", ") ||
          "Sin localidad"
        }
        hint="La localidad se actualiza registrando un movimiento."
        action={
          <a
            href={`/mis-mascotas/${pet.publicToken}/mudanza`}
            className="font-ln-mono text-sm tracking-[.04em] text-[var(--color-ln-azul)] underline underline-offset-2"
          >
            Registrar mudanza
          </a>
        }
      >
        <input
          type="hidden"
          name="provinceCode"
          value={provinceByName(pet.jurisdictionProvince)?.code ?? ""}
        />
        <input type="hidden" name="provinceName" value={pet.jurisdictionProvince ?? ""} />
        <input type="hidden" name="localityName" value={pet.jurisdictionLocality ?? ""} />
      </LnReadOnlyField>
      <MicrochipBlock existingCanonicalChip={existingCanonicalChip} />
    </EditSection>
  );
}
