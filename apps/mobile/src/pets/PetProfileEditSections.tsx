// The six sections of "Editar datos" — ONE COMPONENT PER SECTION (owner-pet-actions).
//
// The screen (`PetProfileEditScreen`) owns the read, the drafts, the saves and
// the scroll; each component here draws one section from the drafts it is
// handed and reports edits and saves upward. Splitting them is not tidiness:
// six forms in one function is a function no reviewer can hold and the
// repo's complexity lint refuses, and a section is the unit the PO's plan
// speaks in — Identidad, Salud y cuidados, Contactos, Qué muestra la
// credencial pública, Seguro, Origen.
//
// EVERY AFFORDANCE STILL COMES FROM `capabilities`. A section the server does
// not let this person edit draws its REASON in place of the form, never a form
// whose Guardar can only be refused; the sentences live in the view-model.
//
// EACH GUARDAR SAVES ITS OWN SECTION — the view-model's builders send that
// section and `null` for the rest — and its outcome is printed INSIDE the
// section it belongs to: on a screen this long, a message at the top would be
// off screen when somebody saves the fifth section.

import type { PetProfileDraftV1, PetProfileEditV1 } from "@dim/contract/api";
import { PET_SPECIES, type PetSpecies } from "@dim/contract/input";
import {
  COMMON_ALLERGIES,
  COMMON_FOODS,
  INSURANCE_COMPANIES,
  LOCALITY_FIELD_LABEL,
  PERMANENT_CONDITIONS,
  PERMANENT_CONDITION_GROUPS,
  type PermanentCondition,
  type PetProfileEditSectionId,
  permanentConditionGroup,
  permanentConditionLabel,
  petProfileEditSection,
} from "@dim/contract/reference";
import { useMemo, useState } from "react";
import { Keyboard, Pressable, StyleSheet, Switch, Text, View } from "react-native";

import { Body, Card } from "../ui/components";
import { FONTS } from "../ui/fonts";
import {
  Callout,
  Choice,
  FieldLabel,
  PrimaryButton,
  RIPPLE,
  SecondaryButton,
  TextField,
} from "../ui/kit";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TYPE } from "../ui/theme";
import { useReturnKeyChain } from "../ui/use-return-key-chain";
import { SEX_OPTIONS, petSexLabel } from "./pet-field-options";
import {
  ACQUISITION_CHOICES,
  type CommandResult,
  type EditDrafts,
  type EmergencyDraft,
  FIELD_LIMITS,
  type HealthDraft,
  type IdentityDraft,
  type IdentityExtrasDraft,
  type InsuranceDraft,
  type OriginDraft,
  type PublicCredentialDraft,
  type SaveGroup,
  TRAINING_CHOICES,
  accountFallbackLabel,
  acquisitionChoiceLabel,
  breedChoicesFor,
  buildCorrectSpecies,
  buildEmergencyContacts,
  buildIdentityEdit,
  buildProfileHealth,
  buildProfileIdentity,
  buildProfileInsurance,
  buildProfileOrigin,
  buildProfilePublicCredential,
  contactsBlockedReason,
  fromChoice,
  identityBlockedReason,
  identityFieldCaps,
  profileBlockedReason,
  profileFieldCaps,
  speciesBlockedReason,
  toChoice,
  toggleCatalogPick,
  trainingChoiceLabel,
} from "./pet-profile-edit-view-model";
import { speciesLabel } from "./species";

/** What just happened, and in which section to say it. */
export type Notice = { group: SaveGroup; tone: "ok" | "err"; message: string } | null;

/** A section's Guardar: the save group, and the command its builder produced (or its refusal). */
export type Save = (group: SaveGroup, built: CommandResult) => void;

type SectionProps = {
  view: PetProfileEditV1;
  drafts: EditDrafts;
  busy: boolean;
  notice: Notice;
  onSave: Save;
};

type Chain = ReturnType<typeof useReturnKeyChain>;

const SEX_VALUES = SEX_OPTIONS.map((option) => option.value);

/** The chip label for a catalogue entry that IS its own label (foods, allergies). */
const asIs = (value: string) => value;

/**
 * Contactos' Guardar. The contract's list gives it none — on the web the section
 * is a door to the emergency-contact sheet — while here it is a form of its own.
 */
const CONTACTS_SAVE_LABEL = "Guardar contactos";

/**
 * A section's title and the name of its Guardar, from the contract's ONE list
 * (`PET_PROFILE_EDIT_SECTIONS`), the list the web form draws from too: two
 * hand-kept copies of six titles is how "Guardar visibilidad" here came to sit
 * beside "Guardar lo que se muestra" there.
 */
function sectionCopy(id: PetProfileEditSectionId): { title: string; saveLabel: string } {
  const section = petProfileEditSection(id);
  return { title: section.title, saveLabel: section.saveLabel ?? CONTACTS_SAVE_LABEL };
}

// ---------------------------------------------------------------------------
// Identidad
// ---------------------------------------------------------------------------

/**
 * IDENTIDAD: the name, the breed, the sex, the age and the colour, with ONE
 * Guardar — then, apart, the two corrections that are not fields of it.
 *
 * THE SPECIES CORRECTION AND THE MUDANZA STAY THEIR OWN ACTS, under the form
 * rather than inside it, and the split is the server's (PO decision #40): the
 * species is `correct_species`, with its own event and its own PPP
 * re-evaluation, and the locality is a `movement_recorded`. A species chip in
 * the middle of the form would read as a field the form's Guardar saves.
 */
export function IdentitySection({
  view,
  drafts,
  busy,
  notice,
  onSave,
  onIdentity,
  onExtras,
  onSpecies,
  onMove,
}: SectionProps & {
  onIdentity: (next: IdentityDraft) => void;
  onExtras: (next: IdentityExtrasDraft) => void;
  onSpecies: (next: PetSpecies) => void;
  onMove: () => void;
}) {
  const blocked = identityBlockedReason(view);
  return (
    <>
      <Card title={sectionCopy("identidad").title}>
        {blocked === null ? (
          <IdentityForm
            view={view}
            identity={drafts.identity}
            extras={drafts.profile?.identityExtras ?? null}
            busy={busy}
            onIdentity={onIdentity}
            onExtras={onExtras}
            onSave={onSave}
          />
        ) : (
          <Reason text={blocked} />
        )}
        <GroupNotice notice={notice} group="identity" />
      </Card>
      <SpeciesCorrection
        view={view}
        species={drafts.species}
        busy={busy}
        notice={notice}
        onSpecies={onSpecies}
        onSave={onSave}
      />
      <LocalityDoor onMove={onMove} />
    </>
  );
}

/**
 * The form itself. WITHOUT the profile block (`extras === null`: an org-path
 * holder, or a server that predates the block) it is the three fields it always
 * was, saved through `edit_identity`; with it, the sex and the age join and the
 * save is `edit_profile`'s Identidad section.
 */
function IdentityForm({
  view,
  identity,
  extras,
  busy,
  onIdentity,
  onExtras,
  onSave,
}: {
  view: PetProfileEditV1;
  identity: IdentityDraft;
  extras: IdentityExtrasDraft | null;
  busy: boolean;
  onIdentity: (next: IdentityDraft) => void;
  onExtras: (next: IdentityExtrasDraft) => void;
  onSave: Save;
}) {
  const [breedQuery, setBreedQuery] = useState("");
  // One return-key chain for the typed fields of this save group: name, the
  // two age boxes when they exist, colour. The breed picker and the sex chips
  // are deliberately outside it (see use-return-key-chain).
  const chain = useReturnKeyChain(extras === null ? 2 : 4);
  // GRANDFATHERED against what is stored, never the bare constant: a `TextInput`
  // truncates the value it is handed, so a fixed cap under an already-longer
  // name would shorten it on screen and the next save would write the
  // shortened one. See `identityFieldCaps`.
  const caps = identityFieldCaps(view);
  return (
    <View style={styles.stack}>
      <Body>Cualquier cambio queda registrado en la libreta.</Body>
      <TextField
        {...chain(0)}
        label="Nombre"
        required
        maxLength={caps.name}
        onChangeText={(name) => onIdentity({ ...identity, name })}
        value={identity.name}
      />
      <BreedPicker
        species={view.species}
        storedBreed={view.identity.breed}
        query={breedQuery}
        selected={identity.breed}
        onQuery={setBreedQuery}
        onSelect={(breed) => onIdentity({ ...identity, breed })}
      />
      {extras === null ? null : (
        <>
          <Choice
            label="Sexo"
            required
            options={SEX_VALUES}
            selected={extras.sex}
            optionLabel={petSexLabel}
            onSelect={(sex) => onExtras({ ...extras, sex })}
            disabled={busy}
          />
          <AgeFields extras={extras} chain={chain} onExtras={onExtras} />
        </>
      )}
      <TextField
        {...chain(extras === null ? 1 : 3)}
        label="Color"
        maxLength={caps.color}
        onChangeText={(color) => onIdentity({ ...identity, color })}
        placeholder="Atigrado, negro con blanco en el pecho…"
        value={identity.color}
      />
      <PrimaryButton
        label={sectionCopy("identidad").saveLabel}
        disabled={busy}
        onPress={() =>
          onSave(
            "identity",
            extras === null
              ? buildIdentityEdit(identity, view.identity)
              : buildProfileIdentity(identity, extras, view, new Date()),
          )
        }
      />
    </View>
  );
}

/**
 * THE AGE, AS TWO WHOLE NUMBERS, the way the alta asks for it. Pre-filled with
 * the age the stored birth date reads as today; posted back untouched, the
 * server keeps that date instead of re-estimating it on every save (the drift
 * the web form had). The line under the boxes says so, because "edad" over a
 * field the registry stores as a DATE is otherwise a puzzle.
 */
function AgeFields({
  extras,
  chain,
  onExtras,
}: {
  extras: IdentityExtrasDraft;
  chain: Chain;
  onExtras: (next: IdentityExtrasDraft) => void;
}) {
  return (
    <View style={styles.stack}>
      <View style={styles.pair}>
        <View style={styles.pairCell}>
          <TextField
            {...chain(1)}
            inputMode="numeric"
            label="Años"
            mono
            onChangeText={(ageYears) => onExtras({ ...extras, ageYears })}
            value={extras.ageYears}
          />
        </View>
        <View style={styles.pairCell}>
          <TextField
            {...chain(2)}
            inputMode="numeric"
            label="Meses"
            mono
            onChangeText={(ageMonths) => onExtras({ ...extras, ageMonths })}
            value={extras.ageMonths}
          />
        </View>
      </View>
      <Text style={styles.detail}>
        Edad aproximada. Si no la cambiás, la fecha de nacimiento queda como está.
      </Text>
    </View>
  );
}

/**
 * CORREGIR ESPECIE — the FULL-LOCK path, on this screen rather than on a route
 * of its own. The web puts it one link away from its edit form
 * (`corregir-especie/page.tsx`); a stack navigator has no such sheet, and a
 * card here is where a person who came to fix "Perro" into "Gato" is already
 * looking. The copy is the web sheet's, transcribed.
 */
function SpeciesCorrection({
  view,
  species,
  busy,
  notice,
  onSpecies,
  onSave,
}: {
  view: PetProfileEditV1;
  species: PetSpecies | null;
  busy: boolean;
  notice: Notice;
  onSpecies: (next: PetSpecies) => void;
  onSave: Save;
}) {
  const blocked = speciesBlockedReason(view);
  return (
    <Card title="Corregir especie">
      {blocked === null ? (
        <View style={styles.stack}>
          <Body>
            Corregí la especie solo si se cargó mal. El cambio queda registrado en la libreta y
            vuelve a evaluar las reglas PPP.
          </Body>
          <Choice
            label="Especie correcta"
            required
            options={PET_SPECIES}
            selected={species}
            optionLabel={speciesLabel}
            onSelect={onSpecies}
            disabled={busy}
          />
          <PrimaryButton
            label="Corregir especie"
            disabled={busy}
            onPress={() => onSave("species", buildCorrectSpecies(species))}
          />
        </View>
      ) : (
        <Reason text={blocked} />
      )}
      <GroupNotice notice={notice} group="species" />
    </Card>
  );
}

/**
 * LA JURISDICCIÓN NO SE EDITA ACÁ, y el renglón existe para decirlo donde
 * alguien la va a buscar. Es FULL-LOCK en este camino (PO decision #40): la
 * localidad se corrige registrando un MOVIMIENTO, que appendea un
 * `movement_recorded` a la libreta. Es la misma entrada que la web pone en su
 * formulario (`components/PetForm.tsx`), con su copia transcripta.
 */
function LocalityDoor({ onMove }: { onMove: () => void }) {
  return (
    <Card title={LOCALITY_FIELD_LABEL}>
      <View style={styles.stack}>
        <Body>La localidad se actualiza registrando un movimiento.</Body>
        <SecondaryButton label="Registrar mudanza" onPress={onMove} />
      </View>
    </Card>
  );
}

/**
 * The breed picker: the contract's catalog filtered as you type, with the
 * animal's stored value first when the catalog has lost it (`breedChoicesFor`,
 * the QA A5 grandfather rule made visible).
 */
function BreedPicker({
  species,
  storedBreed,
  query,
  selected,
  onQuery,
  onSelect,
}: {
  species: string;
  storedBreed: string | null;
  query: string;
  selected: string;
  onQuery: (value: string) => void;
  onSelect: (value: string) => void;
}) {
  const options = useMemo(() => breedChoicesFor(species, storedBreed), [species, storedBreed]);
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    // THE STORED BREED AND NOTHING ELSE UNTIL SOMEBODY TYPES (B-01, measured on
    // build 10, shot 102). The list is an ANSWER to a query; the one row kept
    // is the animal's stored breed, so a "Quitar" by accident is undoable
    // without spelling the value from memory.
    if (needle.length === 0) {
      return storedBreed === null || storedBreed.length === 0 ? [] : [storedBreed];
    }
    // Capped, not scrolled forever: 12 rows is a decision, 180 is a list.
    return options.filter((b) => b.toLowerCase().includes(needle)).slice(0, 12);
  }, [options, needle, storedBreed]);

  return (
    <View style={styles.stack}>
      <TextField
        // NO explicit accessibilityLabel (WCAG 2.5.3): the visible label is
        // "Raza", and a voice user saying it must name this control.
        autoCapitalize="none"
        label="Raza"
        onChangeText={onQuery}
        placeholder="Escribí para filtrar"
        value={query}
      />
      {selected.length > 0 ? (
        <Pressable accessibilityRole="button" onPress={() => onSelect("")} style={styles.selected}>
          <Text style={styles.selectedLabel}>{selected}</Text>
          <Text style={styles.selectedClear}>Quitar</Text>
        </Pressable>
      ) : (
        <Body>Sin raza registrada. Es opcional.</Body>
      )}
      {filtered.length === 0 ? (
        // "No encontramos esa raza" answers a SEARCH; with nothing typed there
        // was none, so an empty list says nothing.
        needle.length === 0 ? null : (
          <Body>No encontramos esa raza en el catálogo.</Body>
        )
      ) : (
        filtered.map((breed) => (
          <Pressable
            accessibilityRole="button"
            key={breed}
            onPress={() => {
              // U-6: the search keyboard stayed open over the chosen-breed chip.
              Keyboard.dismiss();
              onSelect(breed);
            }}
            style={styles.option}
          >
            <Text style={styles.optionLabel}>{breed}</Text>
          </Pressable>
        ))
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Salud y cuidados
// ---------------------------------------------------------------------------

/** SALUD Y CUIDADOS: comidas, alergias, entrenamiento, condiciones permanentes. */
export function HealthSection({
  view,
  drafts,
  busy,
  notice,
  onSave,
  onChange,
}: SectionProps & { onChange: (next: HealthDraft) => void }) {
  const blocked = profileBlockedReason(view);
  const draft = drafts.profile?.health ?? null;
  // What the animal already holds — the free-text caps measure only NEW values.
  const stored = view.profile ?? null;
  return (
    <Card title={sectionCopy("salud").title}>
      {blocked === null && draft !== null && stored !== null ? (
        <HealthForm draft={draft} stored={stored} busy={busy} onChange={onChange} onSave={onSave} />
      ) : (
        <Reason text={blocked ?? "No pudimos cargar esta sección."} />
      )}
      <GroupNotice notice={notice} group="health" />
    </Card>
  );
}

/**
 * The web form's shape, kept: catalogue chips, and the owner's own entries as
 * comma-separated text beside them. Each free-text box is its own one-field
 * chain — "next" from one would jump over the chips between them.
 */
function HealthForm({
  draft,
  stored,
  busy,
  onChange,
  onSave,
}: {
  draft: HealthDraft;
  stored: PetProfileDraftV1;
  busy: boolean;
  onChange: (next: HealthDraft) => void;
  onSave: Save;
}) {
  const foodsChain = useReturnKeyChain(1);
  const allergiesChain = useReturnKeyChain(1);
  return (
    <View style={styles.stack}>
      <ChipToggles
        label="Comidas favoritas"
        options={COMMON_FOODS}
        selected={draft.foods}
        optionLabel={asIs}
        disabled={busy}
        onToggle={(food) =>
          onChange({ ...draft, foods: toggleCatalogPick(COMMON_FOODS, draft.foods, food) })
        }
      />
      <TextField
        {...foodsChain(0)}
        label="Otras comidas"
        placeholder="Separalas con comas"
        onChangeText={(foodsOther) => onChange({ ...draft, foodsOther })}
        value={draft.foodsOther}
      />
      <ChipToggles
        label="Alergias conocidas"
        options={COMMON_ALLERGIES}
        selected={draft.allergies}
        optionLabel={asIs}
        disabled={busy}
        onToggle={(allergy) =>
          onChange({
            ...draft,
            allergies: toggleCatalogPick(COMMON_ALLERGIES, draft.allergies, allergy),
          })
        }
      />
      <TextField
        {...allergiesChain(0)}
        label="Otras alergias"
        placeholder="Separalas con comas"
        onChangeText={(allergiesOther) => onChange({ ...draft, allergiesOther })}
        value={draft.allergiesOther}
      />
      <Choice
        label="Nivel de entrenamiento"
        options={TRAINING_CHOICES}
        selected={toChoice(draft.trainingLevel)}
        optionLabel={trainingChoiceLabel}
        onSelect={(choice) => onChange({ ...draft, trainingLevel: fromChoice(choice) })}
        disabled={busy}
      />
      <ConditionPicker
        draft={draft}
        otherMaxLength={profileFieldCaps(stored).conditionOther}
        busy={busy}
        onChange={onChange}
      />
      <PrimaryButton
        label={sectionCopy("salud").saveLabel}
        disabled={busy}
        onPress={() => onSave("health", buildProfileHealth(draft, stored))}
      />
    </View>
  );
}

/** The catalogue's codes for one of its groups (Sensorial, Motor, Médico, Otro). */
function conditionsOf(groupId: (typeof PERMANENT_CONDITION_GROUPS)[number]["id"]) {
  return PERMANENT_CONDITIONS.filter((code) => permanentConditionGroup(code) === groupId);
}

/**
 * CONDICIONES PERMANENTES, grouped as the web groups them. "Otra" opens its
 * description, which the save refuses empty or carrying a phone or an email:
 * the text can render on the PUBLIC credential.
 */
function ConditionPicker({
  draft,
  otherMaxLength,
  busy,
  onChange,
}: {
  draft: HealthDraft;
  /** The description's cap for THIS animal (`profileFieldCaps`). */
  otherMaxLength: number;
  busy: boolean;
  onChange: (next: HealthDraft) => void;
}) {
  const otherChain = useReturnKeyChain(1);
  const toggle = (code: PermanentCondition) =>
    onChange({
      ...draft,
      conditions: toggleCatalogPick(PERMANENT_CONDITIONS, draft.conditions, code),
    });
  return (
    <View style={styles.stack}>
      <Text style={styles.groupTitle}>Condiciones permanentes</Text>
      <Text style={styles.detail}>
        Marcá si tu mascota convive con alguna condición de por vida (sentidos, movilidad, salud).
      </Text>
      {PERMANENT_CONDITION_GROUPS.map((group) => (
        <ChipToggles
          key={group.id}
          label={group.label}
          options={conditionsOf(group.id)}
          selected={draft.conditions}
          optionLabel={permanentConditionLabel}
          disabled={busy}
          onToggle={toggle}
        />
      ))}
      {draft.conditions.includes("otra") ? (
        <TextField
          {...otherChain(0)}
          label="Especificá la condición"
          required
          maxLength={otherMaxLength}
          onChangeText={(conditionsOther) => onChange({ ...draft, conditionsOther })}
          value={draft.conditionsOther}
        />
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Contactos
// ---------------------------------------------------------------------------

/**
 * CONTACTOS DE EMERGENCIA — the titular's own vet and person to call. Four
 * override columns and no event, because they are a preference of the person,
 * not a fact about the pet; and the legal owner's alone, which is why this
 * section can be refused while the others are offered.
 */
export function ContactsSection({
  view,
  drafts,
  busy,
  notice,
  onSave,
  onChange,
}: SectionProps & { onChange: (next: EmergencyDraft) => void }) {
  const blocked = contactsBlockedReason(view);
  const draft = drafts.contacts;
  return (
    <Card title={sectionCopy("contactos").title}>
      {blocked === null && draft !== null ? (
        <ContactsForm view={view} draft={draft} busy={busy} onChange={onChange} onSave={onSave} />
      ) : (
        <Reason text={blocked ?? "No pudimos cargar los contactos."} />
      )}
      <GroupNotice notice={notice} group="contacts" />
    </Card>
  );
}

function ContactsForm({
  view,
  draft,
  busy,
  onChange,
  onSave,
}: {
  view: PetProfileEditV1;
  draft: EmergencyDraft;
  busy: boolean;
  onChange: (next: EmergencyDraft) => void;
  onSave: Save;
}) {
  const chain = useReturnKeyChain(4);
  return (
    <View style={styles.stack}>
      <Body>Estos datos son de esta mascota. Si dejás un campo vacío usamos el de tu cuenta.</Body>

      <Text style={styles.groupTitle}>Veterinario</Text>
      <TextField
        {...chain(0)}
        label="Nombre del veterinario"
        maxLength={FIELD_LIMITS.contactName}
        onChangeText={(preferredVetName) => onChange({ ...draft, preferredVetName })}
        value={draft.preferredVetName}
      />
      <TextField
        {...chain(1)}
        label="Teléfono del veterinario"
        keyboardType="phone-pad"
        maxLength={FIELD_LIMITS.contactPhone}
        onChangeText={(preferredVetPhone) => onChange({ ...draft, preferredVetPhone })}
        value={draft.preferredVetPhone}
      />
      <Text style={styles.detail}>{accountFallbackLabel(view, "vet")}</Text>

      <Text style={styles.groupTitle}>Contacto de emergencia</Text>
      <TextField
        {...chain(2)}
        label="Nombre del contacto"
        maxLength={FIELD_LIMITS.contactName}
        onChangeText={(emergencyContactName) => onChange({ ...draft, emergencyContactName })}
        value={draft.emergencyContactName}
      />
      <TextField
        {...chain(3)}
        label="Teléfono del contacto"
        keyboardType="phone-pad"
        maxLength={FIELD_LIMITS.contactPhone}
        onChangeText={(emergencyContactPhone) => onChange({ ...draft, emergencyContactPhone })}
        value={draft.emergencyContactPhone}
      />
      <Text style={styles.detail}>{accountFallbackLabel(view, "emergency")}</Text>

      <PrimaryButton
        label={sectionCopy("contactos").saveLabel}
        disabled={busy}
        onPress={() => onSave("contacts", buildEmergencyContacts(draft))}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Qué muestra la credencial pública
// ---------------------------------------------------------------------------

/**
 * QUÉ MUESTRA LA CREDENCIAL PÚBLICA — the two switches that change what a
 * STRANGER sees, which no other field of this screen does. Their own section,
 * so the decision is taken looking at it rather than as a side effect of
 * editing an allergy. Copy from the web form's two toggles.
 */
export function PublicCredentialSection({
  view,
  drafts,
  busy,
  notice,
  onSave,
  onChange,
}: SectionProps & { onChange: (next: PublicCredentialDraft) => void }) {
  const blocked = profileBlockedReason(view);
  const draft = drafts.profile?.publicCredential ?? null;
  return (
    <Card title={sectionCopy("credencial-publica").title}>
      {blocked === null && draft !== null ? (
        <View style={styles.stack}>
          <Body>Esto cambia lo que ve cualquier persona que escanea el QR de la credencial.</Body>
          <ToggleRow
            label="Mostrar aviso de emergencia médica en la credencial pública"
            description="Aparece en la página pública sin revelar tu nombre ni datos sensibles."
            value={draft.emergencyInfoVisible}
            disabled={busy}
            onChange={(emergencyInfoVisible) => onChange({ ...draft, emergencyInfoVisible })}
          />
          <ToggleRow
            label="Compartir las condiciones permanentes en superficies públicas"
            description="Cuando está activado, se muestran en la credencial pública y en la ficha de adopción si un refugio publica a la mascota."
            value={draft.discloseConditionsPublicly}
            disabled={busy}
            onChange={(discloseConditionsPublicly) =>
              onChange({ ...draft, discloseConditionsPublicly })
            }
          />
          <PrimaryButton
            label={sectionCopy("credencial-publica").saveLabel}
            disabled={busy}
            onPress={() => onSave("publicCredential", buildProfilePublicCredential(draft))}
          />
        </View>
      ) : (
        <Reason text={blocked ?? "No pudimos cargar esta sección."} />
      )}
      <GroupNotice notice={notice} group="publicCredential" />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Seguro
// ---------------------------------------------------------------------------

/** Two of the insurers the contract lists, as the example a placeholder gives. */
const INSURER_EXAMPLE = `${INSURANCE_COMPANIES.slice(0, 2).join(", ")}…`;

/** SEGURO: the company and the policy number. An emptied field clears it. */
export function InsuranceSection({
  view,
  drafts,
  busy,
  notice,
  onSave,
  onChange,
}: SectionProps & { onChange: (next: InsuranceDraft) => void }) {
  const chain = useReturnKeyChain(2);
  const blocked = profileBlockedReason(view);
  const draft = drafts.profile?.insurance ?? null;
  // What the animal already holds — the caps measure, and the inputs admit, it.
  const stored = view.profile ?? null;
  const caps = stored === null ? null : profileFieldCaps(stored);
  return (
    <Card title={sectionCopy("seguro").title}>
      {blocked === null && draft !== null && stored !== null && caps !== null ? (
        <View style={styles.stack}>
          <TextField
            {...chain(0)}
            label="Compañía"
            placeholder={INSURER_EXAMPLE}
            maxLength={caps.insuranceCompany}
            onChangeText={(insuranceCompany) => onChange({ ...draft, insuranceCompany })}
            value={draft.insuranceCompany}
          />
          <TextField
            {...chain(1)}
            label="Número de póliza"
            mono
            autoCapitalize="characters"
            maxLength={caps.insurancePolicyNumber}
            onChangeText={(insurancePolicyNumber) => onChange({ ...draft, insurancePolicyNumber })}
            value={draft.insurancePolicyNumber}
          />
          <PrimaryButton
            label={sectionCopy("seguro").saveLabel}
            disabled={busy}
            onPress={() => onSave("insurance", buildProfileInsurance(draft, stored))}
          />
        </View>
      ) : (
        <Reason text={blocked ?? "No pudimos cargar esta sección."} />
      )}
      <GroupNotice notice={notice} group="insurance" />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Origen
// ---------------------------------------------------------------------------

/** ORIGEN: how the animal came home — the alta's question, editable at last. */
export function OriginSection({
  view,
  drafts,
  busy,
  notice,
  onSave,
  onChange,
}: SectionProps & { onChange: (next: OriginDraft) => void }) {
  const blocked = profileBlockedReason(view);
  const draft = drafts.profile?.origin ?? null;
  return (
    <Card title={sectionCopy("origen").title}>
      {blocked === null && draft !== null ? (
        <View style={styles.stack}>
          <Choice
            label="¿Cómo llegó a tu casa?"
            options={ACQUISITION_CHOICES}
            selected={toChoice(draft.acquisitionMethod)}
            optionLabel={acquisitionChoiceLabel}
            onSelect={(choice) => onChange({ acquisitionMethod: fromChoice(choice) })}
            disabled={busy}
          />
          <PrimaryButton
            label={sectionCopy("origen").saveLabel}
            disabled={busy}
            onPress={() => onSave("origin", buildProfileOrigin(draft))}
          />
        </View>
      ) : (
        <Reason text={blocked ?? "No pudimos cargar esta sección."} />
      )}
      <GroupNotice notice={notice} group="origin" />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** Why a section is not offered, in place of its form. */
function Reason({ text }: { text: string }) {
  return (
    <Callout tone="neutral">
      <Body>{text}</Body>
    </Callout>
  );
}

/** The outcome of THIS section's last save — or nothing, when it was another's. */
function GroupNotice({ notice, group }: { notice: Notice; group: SaveGroup }) {
  if (notice === null || notice.group !== group) return null;
  return (
    <Callout tone={notice.tone}>
      <Body>{notice.message}</Body>
    </Callout>
  );
}

/**
 * Several-of-N chips — the multi-select sibling of the kit's `Choice`, in its
 * anatomy and its chip geometry.
 *
 * LOCAL, NOT IN THE KIT: its three callers are on this one screen (foods,
 * allergies, conditions), and the kit's rule is that a primitive moves there
 * the day a second SCREEN needs it.
 *
 * `checkbox` WITH `checked`, so a screen reader announces each chip as a thing
 * with two states; and the question rides on each chip as its HINT, because a
 * checkbox has no group role that would carry it the way `radiogroup` does.
 */
function ChipToggles<T extends string>({
  label,
  options,
  selected,
  optionLabel,
  disabled,
  onToggle,
}: {
  label: string;
  options: readonly T[];
  selected: readonly string[];
  optionLabel: (value: T) => string;
  disabled: boolean;
  onToggle: (value: T) => void;
}) {
  return (
    <View style={styles.choiceField}>
      <FieldLabel>{label}</FieldLabel>
      <View style={styles.chipRow}>
        {options.map((option) => {
          const on = selected.includes(option);
          return (
            <Pressable
              key={option}
              accessibilityRole="checkbox"
              accessibilityLabel={optionLabel(option)}
              accessibilityHint={label}
              accessibilityState={{ checked: on, disabled }}
              android_ripple={RIPPLE}
              disabled={disabled}
              onPress={() => {
                Keyboard.dismiss();
                onToggle(option);
              }}
              style={[styles.chip, on ? styles.chipOn : null]}
            >
              <Text style={on ? styles.chipLabelOn : styles.chipLabel}>{optionLabel(option)}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * One switch with its sentence. The core `Switch` and nothing else — no new
 * native module, so the Expo fingerprint does not move. The label is the
 * switch's accessible name and the description its hint, so TalkBack reads the
 * consequence before the state.
 */
function ToggleRow({
  label,
  description,
  value,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  value: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.toggleRow}>
      <View style={styles.toggleText}>
        <Text style={styles.toggleLabel}>{label}</Text>
        <Text style={styles.detail}>{description}</Text>
      </View>
      <Switch
        accessibilityLabel={label}
        accessibilityHint={description}
        value={value}
        disabled={disabled}
        onValueChange={onChange}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: SPACE.sm },
  pair: { flexDirection: "row", gap: SPACE.md },
  pairCell: { flex: 1 },
  groupTitle: {
    fontFamily: FONTS.sansSemibold,
    fontSize: TYPE.base,
    color: COLORS.ink,
    marginTop: SPACE.xs,
  },
  detail: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.sm,
    color: COLORS.inkMuted,
  },
  selected: {
    minHeight: TOUCH_TARGET,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: COLORS.accent,
    borderRadius: 4,
    paddingHorizontal: SPACE.sm,
    paddingVertical: SPACE.sm,
  },
  selectedLabel: { fontFamily: FONTS.sansSemibold, fontSize: TYPE.base, color: COLORS.ink },
  selectedClear: { fontFamily: FONTS.mono, fontSize: TYPE.sm, color: COLORS.accent },
  option: {
    minHeight: TOUCH_TARGET,
    justifyContent: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
    paddingVertical: SPACE.sm,
  },
  optionLabel: { fontFamily: FONTS.sans, fontSize: TYPE.base, color: COLORS.ink },
  // The kit's `Choice` chip, mirrored value for value so the two read as one
  // family; change both or neither.
  choiceField: { alignSelf: "stretch", gap: SPACE.xs },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.sm },
  chip: {
    minHeight: TOUCH_TARGET,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    borderRadius: RADIUS.chip,
    backgroundColor: COLORS.surface,
    paddingHorizontal: SPACE.md,
  },
  chipOn: { borderColor: COLORS.accent, backgroundColor: COLORS.focusRing },
  chipLabel: { fontFamily: FONTS.sans, fontSize: TYPE.md, color: COLORS.ink },
  chipLabelOn: { fontFamily: FONTS.sansSemibold, fontSize: TYPE.md, color: COLORS.accent },
  toggleRow: {
    minHeight: TOUCH_TARGET,
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
  },
  toggleText: { flex: 1, gap: 2 },
  toggleLabel: { fontFamily: FONTS.sansMedium, fontSize: TYPE.md, color: COLORS.ink },
});
