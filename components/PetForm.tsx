"use client";

// Shared pet form. Used by both /mis-mascotas/nueva (create) and
// /mis-mascotas/[token]/editar (edit). Mode is determined by the `existingPet`
// prop — present means edit, absent means create. The action prop is bound
// at the call site so the form doesn't need to know which it's calling.
//
// Field layout (edit path — 3-tier redesign):
//   TOP tier      — most-used fields everyone fills: name, species, sex, color, photo, location.
//   "Otros"       — collapsible <details> block: breed, weight, age, foods, allergies,
//                   training, acquisition, insurance, microchip.
//   Sensitive     — gated behind a ConfirmDialog warn before revealing:
//                   permanent conditions + public disclosure toggles.

import { CustodyKindToggle } from "@/components/CustodyKindToggle";
import { LnChip, LnChipGroup } from "@/components/ui/Chip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LnCallout } from "@/components/ui/DocElements";
import { LnField, LnInput, LnSelect } from "@/components/ui/Field";
import { LnToggle } from "@/components/ui/Toggle";
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
  MICROCHIP_LOCATIONS,
  TRAINING_LEVELS,
} from "@/lib/reference/lookups";
import {
  PERMANENT_CONDITIONS,
  PERMANENT_CONDITION_GROUPS,
  type PermanentCondition,
  permanentConditionGroup,
  permanentConditionLabel,
} from "@/lib/reference/permanent-conditions";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { speciesLabel } from "@/lib/utils/format";
import type { NewPetFormState } from "@/src/modules/pets/domain/types";
import { LOCALITY_FIELD_LABEL } from "@dim/contract/reference";
import { useActionState, useMemo, useRef, useState } from "react";
import { LocationFields } from "./LocationFields";

const initialState: NewPetFormState = { error: null };

type FormAction = (prev: NewPetFormState, formData: FormData) => Promise<NewPetFormState>;

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

export function PetForm({
  action,
  existingPet,
  existingPhotoUrl,
  existingCanonicalChip,
  compact,
  submitLabel,
  pendingLabel,
  hiddenFields,
  pppBreedList,
}: {
  action: FormAction;
  existingPet?: Pet;
  existingPhotoUrl?: string | null;
  /** ARCH-S: canonical chip pre-fill for edit mode. Replaces dropped pets.microchipId* columns. */
  existingCanonicalChip?: ExistingCanonicalChip | null;
  compact?: boolean;
  submitLabel?: string;
  pendingLabel?: string;
  hiddenFields?: Record<string, string>;
  /**
   * Jurisdiction-resolved PPP breed list (govt_business_rules `ppp_breed_list`
   * for the pet's jurisdiction). When provided, the inline "raza peligrosa"
   * warning flags breeds a locality ADDED via the admin console — not just the
   * static country-wide set. Resolved server-side by the page that renders the
   * form. Optional: absent → fall back to the static country-wide list.
   */
  pppBreedList?: readonly string[];
}) {
  const isEdit = !!existingPet;
  // forms/react19-reset-data-loss-inventory: "sex" is a <select> with a
  // static defaultValue and no changing key — never safe on its own (a
  // rejected submit falls it back to its FIRST option, "No sé").
  const { boundAction, kept } = useKeptFields<NewPetFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  // N3: the action returns where to go and this navigates. It used to
  // redirect() server-side — a transition the App Router drops in production,
  // so the edit saved and the screen never moved.
  useActionRedirect(state.redirectTo, state);
  const [photoPreview, setPhotoPreview] = useState<string | null>(existingPhotoUrl ?? null);
  const [species, setSpecies] = useState<string>(existingPet?.species ?? "");
  const [breed, setBreed] = useState<string>(existingPet?.breed ?? "");

  const OTHER_SPECIES_VALUES = ["rabbit", "guinea_pig", "ferret"] as const;
  type OtherSpeciesValue = (typeof OTHER_SPECIES_VALUES)[number];
  function isCompanionOther(value: string): value is OtherSpeciesValue {
    return (OTHER_SPECIES_VALUES as readonly string[]).includes(value);
  }
  const speciesGroup: "" | "dog" | "cat" | "other" =
    species === "dog" || species === "cat" ? species : species === "" ? "" : "other";
  const subSpecies: OtherSpeciesValue | "other_unlisted" | "" = isCompanionOther(species)
    ? species
    : species === "other"
      ? "other_unlisted"
      : "";
  const [custodyKind, setCustodyKind] = useState<"owner" | "foster_in_transit">("owner");

  const initialConditions: ReadonlyArray<PermanentCondition> =
    (existingPet?.permanentConditions ?? []).filter((c): c is PermanentCondition =>
      (PERMANENT_CONDITIONS as readonly string[]).includes(c),
    ) ?? [];
  const [conditions, setConditions] = useState<Set<PermanentCondition>>(new Set(initialConditions));
  const [conditionsOther, setConditionsOther] = useState<string>(
    existingPet?.permanentConditionsOther ?? "",
  );
  const [discloseConditions, setDiscloseConditions] = useState<boolean>(
    existingPet?.discloseConditionsPublicly ?? false,
  );
  const [emergencyInfoVisible, setEmergencyInfoVisible] = useState<boolean>(
    existingPet?.emergencyInfoVisible ?? false,
  );

  // Sensitive section gate — user must confirm before editing conditions/toggles.
  const [sensitiveUnlocked, setSensitiveUnlocked] = useState<boolean>(false);
  const [sensitiveDialogOpen, setSensitiveDialogOpen] = useState<boolean>(false);
  const sensitiveButtonRef = useRef<HTMLButtonElement>(null);

  // Controlled field state — preserves typed input on validation error.
  const [name, setName] = useState<string>(existingPet?.name ?? "");
  const [color, setColor] = useState<string>(existingPet?.color ?? "");
  const [trainingLevel, setTrainingLevel] = useState<string>(existingPet?.trainingLevel ?? "");
  const [acquisitionMethod, setAcquisitionMethod] = useState<string>(
    existingPet?.acquisitionMethod ?? "",
  );
  const [insuranceCompany, setInsuranceCompany] = useState<string>(
    existingPet?.insuranceCompany ?? "",
  );
  const [insurancePolicyNumber, setInsurancePolicyNumber] = useState<string>(
    existingPet?.insurancePolicyNumber ?? "",
  );
  const [estimatedWeightKg, setEstimatedWeightKg] = useState<string>(
    existingPet?.estimatedWeightKg != null ? String(existingPet.estimatedWeightKg) : "",
  );
  const [favouriteFoodsOther, setFavouriteFoodsOther] = useState<string>(
    (existingPet?.favouriteFoods ?? []).filter((v) => !new Set(COMMON_FOODS).has(v)).join(", "),
  );
  const [knownAllergiesOther, setKnownAllergiesOther] = useState<string>(
    (existingPet?.knownAllergies ?? []).filter((v) => !new Set(COMMON_ALLERGIES).has(v)).join(", "),
  );

  function toggleCondition(code: PermanentCondition) {
    setConditions((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  // Catalog options for the breed SELECT (2026-08-13: the field stopped being
  // free text — see the field below for why).
  //
  // A breed already on file that is NOT in the catalog is appended as its own
  // option. Without that, a <select> whose value matches no <option> renders
  // blank and the next save WIPES a recorded breed — turning a data-quality fix
  // into data loss. Legacy values stay selectable and stay saved.
  const breedOptions = useMemo(() => {
    const catalog = breedsForSpecies(species);
    const current = breed.trim();
    return current && !catalog.includes(current) ? [...catalog, current] : catalog;
  }, [species, breed]);
  // Inline "raza peligrosa" warning. When the page threads the jurisdiction-
  // resolved `ppp_breed_list` down (2026-07-04), a breed a locality ADDED via
  // the admin console is flagged too; without it we fall back to the static
  // country-wide set. Either way this is display-only — the server-side
  // classification at submit time is authoritative (PetForm has no per-keystroke
  // round-trip). NOTE: the in-profile edit SHEET (SheetMounter) does not yet
  // thread the prop, so it stays on the static fallback — a scoped follow-up.
  const breedIsDangerous = useMemo(() => {
    const trimmed = breed.trim();
    if (species !== "dog" || !trimmed) return false;
    // Normalised comparison, NOT `b.trim() === trimmed`. Exact equality here is
    // the same defect that let "Pitbull" escape the PPP regime server-side; a
    // warning that disagrees with the classification is worse than no warning,
    // because the owner reads it as confirmation that the regime does not apply.
    const resolved = resolveBreedLabel(trimmed) ?? trimmed;
    if (pppBreedList) return breedListIncludes(pppBreedList, resolved);
    return isPotentiallyDangerousBreed(species, breed);
  }, [species, breed, pppBreedList]);

  const initialAge = useMemo(
    () => ageFromDateOfBirth(existingPet?.dateOfBirth ?? null),
    [existingPet?.dateOfBirth],
  );

  // Allergy chips state (LnChipGroup)
  const [selectedAllergies, setSelectedAllergies] = useState<string[]>(
    existingPet?.knownAllergies ?? [],
  );
  const [selectedFoods, setSelectedFoods] = useState<string[]>(existingPet?.favouriteFoods ?? []);

  function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (photoPreview?.startsWith("blob:")) {
      URL.revokeObjectURL(photoPreview);
    }
    if (file) {
      setPhotoPreview(URL.createObjectURL(file));
    } else {
      setPhotoPreview(existingPhotoUrl ?? null);
    }
  }

  return (
    <form action={formAction} className="flex flex-col gap-2.5">
      {hiddenFields &&
        Object.entries(hiddenFields).map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}

      {/* Custody toggle — only on create, not compact */}
      {!compact && !isEdit && <CustodyKindToggle value={custodyKind} onChange={setCustodyKind} />}

      {/* ── TOP TIER — most-used, everyone fills ──────────────── */}

      {/* Photo — always visible */}
      <LnPhotoField onFileChange={handlePhotoChange} preview={photoPreview} />

      {/* Name */}
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

      {/* Species — FULL-LOCK (PO decision #40): editable only at registration.
          For an established pet it drives PPP/compliance and is read-only; a
          genuine correction routes through the dedicated "corregir especie"
          affordance below, which emits an event with an audit trail. The hidden
          input still carries the (unchanged) species so parsePetForm validates. */}
      <input type="hidden" name="species" value={species} />
      {isEdit ? (
        <LnReadOnlyField
          label="Especie"
          value={speciesLabel(existingPet?.species ?? species)}
          hint="La especie queda fija para no romper las reglas PPP y de compatibilidad."
          action={
            existingPet ? (
              <a
                href={`/mis-mascotas/${existingPet.publicToken}/corregir-especie`}
                className="font-ln-mono text-sm tracking-[.04em] text-[var(--color-ln-azul)] underline underline-offset-2"
              >
                ¿Especie incorrecta?
              </a>
            ) : null
          }
        />
      ) : (
        <>
          <LnField label="Especie" required>
            {({ id, describedBy, invalid }) => (
              <LnSelect
                id={id}
                name="speciesGroup"
                key={`speciesGroup-${speciesGroup}`}
                required
                defaultValue={speciesGroup}
                onChange={(e) => {
                  const next = e.target.value;
                  if (next === "dog" || next === "cat") {
                    setSpecies(next);
                  } else if (next === "other") {
                    // Fresh-context review, T4-F1 batches 3-4: this used to
                    // set `species` to "" here too, which is the SAME value
                    // it starts at. `speciesGroup` is DERIVED from `species`
                    // (species === "" maps to speciesGroup === "", not
                    // "other"), so picking "Otra" never actually moved
                    // speciesGroup off "" — the subgroup select never
                    // rendered, the key={`speciesGroup-${speciesGroup}`}
                    // never changed, and (now that this select is
                    // uncontrolled) the DOM kept showing "Otra" selected
                    // while React's own state, the hidden `species` input,
                    // and `required`'s view of "is anything answered" all
                    // silently disagreed with it — a dead end that looked
                    // filled in and was rejected server-side.
                    setSpecies("other");
                  } else {
                    setSpecies("");
                  }
                  setBreed("");
                }}
                aria-describedby={describedBy}
                invalid={invalid}
              >
                <option value="">Elegí una</option>
                <option value="dog">Perro</option>
                <option value="cat">Gato</option>
                <option value="other">Otra</option>
              </LnSelect>
            )}
          </LnField>
          {speciesGroup === "other" && (
            <LnField label='Tipo de "Otra"' required>
              {({ id, describedBy, invalid }) => (
                <LnSelect
                  id={id}
                  name="speciesSubgroup"
                  key={`speciesSubgroup-${subSpecies}`}
                  required
                  defaultValue={subSpecies}
                  onChange={(e) => {
                    const next = e.target.value;
                    setSpecies(next === "other_unlisted" ? "other" : next);
                    setBreed("");
                  }}
                  aria-describedby={describedBy}
                  invalid={invalid}
                >
                  <option value="">Elegí una</option>
                  <option value="rabbit">Conejo</option>
                  <option value="guinea_pig">Cobayo</option>
                  <option value="ferret">Hurón</option>
                  <option value="other_unlisted">Otro / no listado</option>
                </LnSelect>
              )}
            </LnField>
          )}
        </>
      )}

      {/* Sex */}
      <LnField label="Sexo" required>
        {({ id, describedBy, invalid }) => (
          <LnSelect
            id={id}
            name="sex"
            key={`sex-${kept("sex")}`}
            required
            defaultValue={kept("sex", existingPet?.sex ?? "unknown")}
            aria-describedby={describedBy}
            invalid={invalid}
          >
            <option value="unknown">No sé</option>
            <option value="male">Macho</option>
            <option value="female">Hembra</option>
          </LnSelect>
        )}
      </LnField>

      {/* Color / marks */}
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

      {/* Location — FULL-LOCK (PO decision #40): jurisdiction is canonical once a
          pet is established. It changes ONLY by registering a movement (event
          movement_recorded / jurisdiction_changed), never through a profile edit.
          Read-only here for an established pet, with hidden inputs so parsePetForm
          still validates the (unchanged) locality. Editable only at registration. */}
      {!compact && isEdit && (
        <LnReadOnlyField
          label={LOCALITY_FIELD_LABEL}
          value={
            [existingPet?.jurisdictionLocality, existingPet?.jurisdictionProvince]
              .filter(Boolean)
              .join(", ") || "Sin localidad"
          }
          hint="La localidad se actualiza registrando un movimiento."
          action={
            existingPet ? (
              <a
                href={`/mis-mascotas/${existingPet.publicToken}/mudanza`}
                className="font-ln-mono text-sm tracking-[.04em] text-[var(--color-ln-azul)] underline underline-offset-2"
              >
                Registrar mudanza
              </a>
            ) : null
          }
        >
          <input
            type="hidden"
            name="provinceCode"
            value={provinceByName(existingPet?.jurisdictionProvince)?.code ?? ""}
          />
          <input
            type="hidden"
            name="provinceName"
            value={existingPet?.jurisdictionProvince ?? ""}
          />
          <input
            type="hidden"
            name="localityName"
            value={existingPet?.jurisdictionLocality ?? ""}
          />
        </LnReadOnlyField>
      )}
      {!compact && !isEdit && (
        <div className="flex flex-col gap-1.5">
          {/* Create mode: no established pet yet, so the picker starts empty.
              `required` renders the "Ciudad, pueblo o barrio *" label + adds native required /
              aria-required on the input; the duplicate wrapper <p> was removed
              (parity with MinimalNewPetForm). */}
          <LocationFields
            mode="l1"
            required
            cascade
            defaultValue={{ provinceCode: null, localityName: null }}
          />
          <p className="font-ln-mono text-sm text-[var(--color-ln-mute)]">
            Requerido. Ayuda a las campañas regionales de salud animal.
          </p>
        </div>
      )}

      {/* ── "OTROS" COLLAPSIBLE SECTION ───────────────────────── */}
      {!compact && (
        <details className="op-disclosure group rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-3 text-sm font-semibold text-[var(--color-ln-ink-2)] select-none">
            <span>Otros datos</span>
            <span
              aria-hidden="true"
              className="text-[var(--color-ln-faint)] transition-transform group-open:rotate-180"
            >
              ▾
            </span>
          </summary>
          <div className="flex flex-col gap-3 border-t border-[var(--color-ln-line)] px-3.5 py-3">
            {/* Breed — dog-only PPP hint (strong-but-optional, never required). */}
            <LnField
              label="Raza"
              hint={
                speciesGroup === "dog"
                  ? "En perros, la raza y el peso definen si entra en el régimen PPP."
                  : undefined
              }
            >
              {/* CATÁLOGO, no texto libre (PO, 2026-08-13).
                  Era un <input list="breed-options">, o sea un datalist: sugiere
                  y acepta cualquier cosa. Medido en staging ese día: 69 mascotas
                  con raza cargada en 44 valores distintos, 34 usados una sola
                  vez. Y una de esas filas era "Pit Bull Terrier Americano" SIN
                  marcar como PPP, mientras un perro idéntico en otro barrio de
                  la misma ciudad sí lo estaba — bajo la misma ley. Lo que decidía
                  si el régimen te alcanza era cómo lo tipeó el dueño.
                  La raza define un régimen legal; no puede depender de la
                  ortografía. */}
              {({ id, describedBy }) => (
                <LnSelect
                  id={id}
                  name="breed"
                  key={`breed-${breed}`}
                  defaultValue={breed}
                  onChange={(e) => setBreed(e.target.value)}
                  disabled={!species}
                  aria-describedby={describedBy}
                >
                  <option value="">{species ? "Elegí una raza…" : "Elegí especie primero"}</option>
                  {breedOptions.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </LnSelect>
              )}
            </LnField>

            {breedIsDangerous && (
              <LnCallout tone="warn" title="Raza potencialmente peligrosa">
                Esta raza está en el registro de razas potencialmente peligrosas (CABA: Ley 4078 ·
                PBA: Ley 14.107). Registrate en el registro provincial correspondiente.
              </LnCallout>
            )}

            {/* Estimated weight — dog-only PPP hint (strong-but-optional). */}
            <LnField
              label="Peso estimado"
              hint={
                speciesGroup === "dog"
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
                  value={estimatedWeightKg}
                  onChange={(e) => setEstimatedWeightKg(e.target.value)}
                  aria-describedby={describedBy}
                />
              )}
            </LnField>

            {/* Age */}
            <LnAgeFields defaultYears={initialAge.years} defaultMonths={initialAge.months} />

            {/* Favourite foods */}
            <div className="flex flex-col gap-1.5">
              <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.12em] text-[var(--color-ln-faint)]">
                Comidas favoritas
              </p>
              {selectedFoods.map((f) => (
                <input key={f} type="hidden" name="favouriteFoods" value={f} />
              ))}
              <LnChipGroup
                items={COMMON_FOODS.map((f) => ({ key: f, label: f }))}
                selected={selectedFoods}
                onChange={setSelectedFoods}
              />
              {/* B-7: aria-label provides accessible name for the unlabeled free-text input */}
              <LnInput
                name="favouriteFoodsOther"
                type="text"
                placeholder="Otros (separá por coma si querés varios)"
                aria-label="Otras comidas favoritas (separadas por coma)"
                value={favouriteFoodsOther}
                onChange={(e) => setFavouriteFoodsOther(e.target.value)}
              />
            </div>

            {/* Known allergies */}
            <div className="flex flex-col gap-1.5">
              <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.12em] text-[var(--color-ln-faint)]">
                Alergias conocidas
              </p>
              {selectedAllergies.map((a) => (
                <input key={a} type="hidden" name="knownAllergies" value={a} />
              ))}
              <LnChipGroup
                items={COMMON_ALLERGIES.map((a) => ({
                  key: a,
                  label: a,
                  tone: "rojo" as const,
                }))}
                selected={selectedAllergies}
                onChange={setSelectedAllergies}
              />
              {/* B-7: aria-label provides accessible name for the unlabeled free-text input */}
              <LnInput
                name="knownAllergiesOther"
                type="text"
                placeholder="Otros (separá por coma si querés varios)"
                aria-label="Otras alergias conocidas (separadas por coma)"
                value={knownAllergiesOther}
                onChange={(e) => setKnownAllergiesOther(e.target.value)}
              />
            </div>

            {/* Training level */}
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

            {/* Acquisition method */}
            <LnField
              label={
                isEdit
                  ? `¿Cómo llegó ${existingPet?.name ?? "tu mascota"}?`
                  : "¿Cómo te encontraste con esta mascota?"
              }
            >
              {({ id, describedBy, invalid }) => (
                <LnSelect
                  id={id}
                  name="acquisitionMethod"
                  key={`acquisitionMethod-${acquisitionMethod}`}
                  defaultValue={acquisitionMethod}
                  onChange={(e) => setAcquisitionMethod(e.target.value)}
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

            {/* Insurance */}
            <div className="flex flex-col gap-2.5 border-t border-[var(--color-ln-line-2)] pt-3">
              <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.12em] text-[var(--color-ln-faint)]">
                Seguro de mascota
              </p>
              <LnField label="Compañía">
                {({ id, describedBy }) => (
                  <LnInput
                    id={id}
                    name="insuranceCompany"
                    type="text"
                    list="insurance-companies"
                    placeholder="Buscar o tipear…"
                    value={insuranceCompany}
                    onChange={(e) => setInsuranceCompany(e.target.value)}
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
                    value={insurancePolicyNumber}
                    onChange={(e) => setInsurancePolicyNumber(e.target.value)}
                    aria-describedby={describedBy}
                  />
                )}
              </LnField>
            </div>

            {/* Microchip */}
            <MicrochipBlock existingCanonicalChip={existingCanonicalChip} />
          </div>
        </details>
      )}

      {/* ── SENSITIVE SECTION — gated behind ConfirmDialog ────── */}
      {!compact && (
        <div className="flex flex-col gap-2.5 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-3.5">
          <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.12em] text-[var(--color-ln-faint)]">
            Condiciones sensibles
          </p>

          {/* Hidden inputs always submitted so existing values are preserved even when section is locked */}
          <input
            type="hidden"
            name="permanentConditions"
            value={Array.from(conditions).join(",")}
          />
          {!conditions.has("otra") && (
            <input type="hidden" name="permanentConditionsOther" value="" />
          )}
          <input
            type="hidden"
            name="discloseConditionsPublicly"
            value={discloseConditions ? "true" : ""}
          />
          <input
            type="hidden"
            name="emergencyInfoVisible"
            value={emergencyInfoVisible ? "true" : ""}
          />

          {!sensitiveUnlocked ? (
            <>
              {(conditions.size > 0 || emergencyInfoVisible) && (
                <p className="text-sm text-[var(--color-ln-mute)]">
                  {conditions.size > 0
                    ? `${conditions.size} ${conditions.size > 1 ? "condiciones registradas" : "condición registrada"}.`
                    : "Aviso de emergencia médica activo."}
                </p>
              )}
              <button
                ref={sensitiveButtonRef}
                type="button"
                onClick={() => setSensitiveDialogOpen(true)}
                className="self-start rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-3 py-2 text-sm font-medium text-[var(--color-ln-ink-2)] transition-colors hover:bg-[var(--color-ln-stripe)]"
              >
                Editar condiciones sensibles
              </button>
            </>
          ) : (
            <SensitiveFields
              conditions={conditions}
              conditionsOther={conditionsOther}
              discloseConditions={discloseConditions}
              emergencyInfoVisible={emergencyInfoVisible}
              onToggleCondition={toggleCondition}
              onConditionsOtherChange={setConditionsOther}
              onDiscloseChange={setDiscloseConditions}
              onEmergencyChange={setEmergencyInfoVisible}
            />
          )}

          <ConfirmDialog
            open={sensitiveDialogOpen}
            onClose={() => setSensitiveDialogOpen(false)}
            onConfirm={() => {
              setSensitiveUnlocked(true);
              setSensitiveDialogOpen(false);
            }}
            title="Editar condiciones sensibles"
            description="Vas a editar condiciones de salud permanentes (como amputaciones o epilepsia). Asegurate de que la información sea correcta antes de guardar."
            confirmLabel="Entendido, editar"
            cancelLabel="Cancelar"
            tone="warn"
            triggerRef={sensitiveButtonRef}
          />
        </div>
      )}

      {state.error && (
        <p className="font-ln-mono text-sm text-[var(--color-ln-err)]" role="alert">
          {state.error}
        </p>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={isPending}
        className={[
          "inline-flex w-full cursor-pointer items-center justify-center gap-[7px] rounded-[var(--radius-pill)] border px-4 py-2.5 text-md font-semibold text-white transition-colors",
          "border-[var(--color-ln-azul)] bg-[var(--color-ln-azul)] hover:bg-[var(--color-ln-azul-700)] hover:border-[var(--color-ln-azul-700)]",
          "disabled:cursor-not-allowed disabled:opacity-60",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {isPending ? (
          <>
            <span
              aria-hidden="true"
              className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
            />
            {pendingLabel ?? "Guardando..."}
          </>
        ) : (
          (submitLabel ?? (isEdit ? "Guardar cambios" : "Crear mascota"))
        )}
      </button>
    </form>
  );
}

// ============================================================================
// Sensitive fields — rendered after user confirms via ConfirmDialog
// ============================================================================

function SensitiveFields({
  conditions,
  conditionsOther,
  discloseConditions,
  emergencyInfoVisible,
  onToggleCondition,
  onConditionsOtherChange,
  onDiscloseChange,
  onEmergencyChange,
}: {
  conditions: Set<PermanentCondition>;
  conditionsOther: string;
  discloseConditions: boolean;
  emergencyInfoVisible: boolean;
  onToggleCondition: (c: PermanentCondition) => void;
  onConditionsOtherChange: (v: string) => void;
  onDiscloseChange: (v: boolean) => void;
  onEmergencyChange: (v: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-[var(--color-ln-mute)]">
        Marcá si tu mascota convive con alguna condición de por vida (sentidos, motora, médica).
      </p>
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
                  <LnChip
                    key={code}
                    selected={conditions.has(code)}
                    onChange={() => onToggleCondition(code)}
                  >
                    {permanentConditionLabel(code)}
                  </LnChip>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {conditions.has("otra") && (
        <LnField label="Especificá la condición" required>
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              name="permanentConditionsOther"
              type="text"
              required
              maxLength={120}
              value={conditionsOther}
              onChange={(e) => onConditionsOtherChange(e.target.value)}
              aria-describedby={describedBy}
              invalid={invalid}
            />
          )}
        </LnField>
      )}
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
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Read-only display for a locked field (FULL-LOCK: species, jurisdiction).
 * Shows the current value plus a hint explaining the governed change path and
 * an optional action link to that path. `children` carries hidden inputs so the
 * server-side parse still receives the (unchanged) value.
 */
function LnReadOnlyField({
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

function ageFromDateOfBirth(dob: string | null): {
  years: number | null;
  months: number | null;
} {
  if (!dob) return { years: null, months: null };
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return { years: null, months: null };
  const now = new Date();
  let totalMonths = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
  if (now.getDate() < d.getDate()) totalMonths -= 1;
  if (totalMonths < 0) totalMonths = 0;
  return {
    years: Math.floor(totalMonths / 12),
    months: totalMonths % 12,
  };
}

function LnAgeFields({
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
          max="40"
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

function MicrochipBlock({
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

function LnPhotoField({
  onFileChange,
  preview,
}: {
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  preview: string | null;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]">
        Foto{" "}
        <span className="font-normal lowercase tracking-[.04em] text-[var(--color-ln-faint)]">
          opcional
        </span>
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
