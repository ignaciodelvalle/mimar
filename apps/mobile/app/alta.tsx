// Alta de mascota — the wizard.
//
// SIX SHORT STEPS RATHER THAN ONE LONG FORM, and the reason is the phone: the
// web's minimal form fits on a laptop screen and reads as "this is all you need
// to do". The same twelve fields stacked on a 6-inch screen reads as a tax
// return, and the person registering an animal is usually doing it standing up,
// once, and never again. Two of the steps ask for nothing required at all.
//
// WHAT THIS SCREEN DOES NOT DECIDE
// ---------------------------------------------------------------------------
//   · Whether the input is valid — `toRegisterPetInput` runs the SERVER'S zod
//     schema, so this app and the route handler cannot disagree about it.
//   · Which localities exist — `/api/v1/localities` answers, and the selected
//     row's `provinceCode` and `localityName` go back to `POST /pets` verbatim.
//     A hardcoded province list here would be a second copy of a catalog whose
//     first copy is a database.
//   · Which breeds exist — `@dim/contract/reference`, static and offline. A
//     catalog a client can render is not a decision a client may make: the
//     WRITE-side authority is still `lib/domain/breed-validation.ts`, and this
//     picker's job is to make the common answer one tap away, not to be right.
//
// THE IDEMPOTENCY KEY IS THE SUBTLE PART. One key from the first confirm until
// the registration finishes, reused across every retry INCLUDING the "Registrar
// igual" answer to a 409. See `pets/idempotency.ts`; the reasoning is long and
// the failure it prevents is a duplicate animal in somebody's account.

import { PET_COLOR_MAX, PET_NAME_MAX } from "@dim/contract/input";
import { breedsForSpecies } from "@dim/contract/reference";
import { useNavigation, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { apiFailureMessage } from "../src/api/client";
import { registerPet } from "../src/api/endpoints";
import { sessionPort } from "../src/auth/session-store";
import { useGate } from "../src/auth/useGate";
import { LocalityPicker } from "../src/pets/LocalityPicker";
import { createAttemptSession } from "../src/pets/idempotency";
import {
  EMPTY_DRAFT,
  type PetDraft,
  WIZARD_STEPS,
  type WizardStep,
  advanceBlockedReason,
  canAdvance,
  stepTitle,
  toRegisterPetInput,
} from "../src/pets/register-input";
import { SPECIES_OPTIONS, speciesLabel } from "../src/pets/species";
import { useDiscardGuard } from "../src/pets/use-discard-guard";
import { Body, Card, ErrorNotice, Row } from "../src/ui/components";
import { FONTS } from "../src/ui/fonts";
import { hapticError, hapticSuccess } from "../src/ui/haptics";
import {
  Eyebrow,
  FieldLabel,
  PrimaryButton,
  Screen,
  SecondaryButton,
  TextField,
  Title,
} from "../src/ui/kit";
import { credentialRoute } from "../src/ui/routes";
import { COLORS, RADIUS, SPACE, TOUCH_TARGET, TYPE } from "../src/ui/theme";

const SEX_OPTIONS = [
  { value: "female", label: "Hembra" },
  { value: "male", label: "Macho" },
  { value: "unknown", label: "No sé" },
] as const;

const ACQUISITION_OPTIONS = [
  { value: "adopted", label: "Adopción" },
  { value: "purchased", label: "Compra" },
  { value: "found_stray", label: "La encontré" },
  { value: "gift", label: "Regalo" },
  { value: "born_in_litter", label: "Nació en casa" },
  { value: "other", label: "Otro" },
] as const;

type Submission =
  | { phase: "idle" }
  | { phase: "sending" }
  | { phase: "failed"; message: string }
  /** The server says this looks like a pet the owner already has. */
  | { phase: "duplicate" };

export default function AltaMascotaScreen() {
  const gate = useGate();
  const router = useRouter();
  const navigation = useNavigation();
  const [stepIndex, setStepIndex] = useState(0);
  const [draft, setDraft] = useState<PetDraft>(EMPTY_DRAFT);
  const [submission, setSubmission] = useState<Submission>({ phase: "idle" });

  // Back-guard (QOL 2026-09-01, walkthrough-measured): hardware back, the
  // header arrow and the iOS swipe all discarded a six-step form in silence.
  // Dirty is object identity — EMPTY_DRAFT is only ever replaced by a patch,
  // so any touched field flips it. The success navigation calls allowLeave()
  // first: the pet exists by then, and there is nothing left to protect.
  const { allowLeave } = useDiscardGuard(navigation, draft !== EMPTY_DRAFT);

  // ONE key for this whole registration. `useRef` and not `useState` because a
  // re-render must not be able to produce a different key, and because nothing
  // renders from it.
  const attempt = useRef(createAttemptSession());

  const step = WIZARD_STEPS[stepIndex] as WizardStep;
  const patch = useCallback((fields: Partial<PetDraft>) => {
    setDraft((current) => ({ ...current, ...fields }));
  }, []);

  const send = useCallback(
    async (overrideDuplicate: boolean) => {
      const nextDraft = overrideDuplicate ? { ...draft, duplicateOverride: true } : draft;
      const verdict = toRegisterPetInput(nextDraft);
      if (!verdict.ok) {
        setSubmission({ phase: "failed", message: verdict.message });
        return;
      }

      setSubmission({ phase: "sending" });
      const result = await registerPet(sessionPort, verdict.input, attempt.current.key());

      if (result.outcome === "ok") {
        // A replay answers 201 with `wasDuplicate: true` and the SAME token —
        // which is success, not an error: it means the first attempt landed and
        // the phone never heard the answer. Either way the destination is the
        // credential, and the next registration gets a new key.
        attempt.current.restart();
        hapticSuccess();
        allowLeave();
        router.replace(credentialRoute(result.payload.publicToken));
        return;
      }

      if (result.outcome === "api-error" && result.code === "duplicate_pet_suspected") {
        setSubmission({ phase: "duplicate" });
        return;
      }

      hapticError();
      setSubmission({
        phase: "failed",
        message: apiFailureMessage(result) ?? "No pudimos completar el registro.",
      });
    },
    [draft, router, allowLeave],
  );

  if (!gate.allowed) return gate.element;

  const isLast = stepIndex === WIZARD_STEPS.length - 1;
  const busy = submission.phase === "sending";
  const blocked = advanceBlockedReason(step, draft);

  return (
    <Screen keyboardAvoiding>
      <View style={styles.masthead}>
        <Eyebrow>{`Paso ${stepIndex + 1} de ${WIZARD_STEPS.length}`}</Eyebrow>
        <Title>{stepTitle(step)}</Title>
      </View>

      <StepBody step={step} draft={draft} patch={patch} />

      {submission.phase === "failed" ? <ErrorNotice message={submission.message} /> : null}
      {submission.phase === "duplicate" ? (
        <DuplicateDialog
          name={draft.name.trim()}
          busy={busy}
          onConfirm={() => void send(true)}
          onCancel={() => {
            setSubmission({ phase: "idle" });
            router.back();
          }}
        />
      ) : null}

      {/* CA-M5: a disabled button announces "atenuado" and nothing else. The
          sentence says what is missing, and `accessibilityLiveRegion` makes a
          screen reader read it when it appears rather than only on a visit. */}
      {blocked === null ? null : (
        <Text accessibilityLiveRegion="polite" style={styles.blockedReason}>
          {blocked}
        </Text>
      )}

      {/* THE FOUR-VERB RULE, WHICH THIS WIZARD WAS OUTSIDE OF (A2-alta-asentar-R05,
          AGENTS.md §"Four verbs for primary buttons"). "Siguiente" is not one of
          the four — the wizard verb is `Continuar` — and "Registrar" was bare,
          which the rule forbids by name: the object goes in the label, so the
          last step says WHAT it registers. The web says "Continuar" for the same
          steps, so this is also parity rather than only style. */}
      <View style={styles.nav}>
        {isLast ? (
          <PrimaryButton
            label={busy ? "Registrando…" : "Registrar mascota"}
            disabled={busy || !canAdvance(step, draft)}
            onPress={() => void send(false)}
          />
        ) : (
          <PrimaryButton
            label="Continuar"
            disabled={!canAdvance(step, draft)}
            onPress={() => setStepIndex((i) => Math.min(i + 1, WIZARD_STEPS.length - 1))}
          />
        )}
        {stepIndex === 0 ? null : (
          <SecondaryButton
            label="Volver"
            disabled={busy}
            onPress={() => setStepIndex((i) => Math.max(i - 1, 0))}
          />
        )}
      </View>
    </Screen>
  );
}

function StepBody({
  step,
  draft,
  patch,
}: {
  step: WizardStep;
  draft: PetDraft;
  patch: (fields: Partial<PetDraft>) => void;
}) {
  switch (step) {
    case "nombre":
      return (
        // No explicit `accessibilityLabel`: it repeated the visible label and,
        // before the kit's `accessibleName` fix (CA-M1), took ", obligatorio"
        // with it — a required field that announced nothing about being one.
        // `maxLength` is the CAP THE SERVER ENFORCES (PET_NAME_MAX), so the
        // field cannot accept a name the confirm step will refuse. Safe to
        // truncate here in a way `EditarMascota`'s field is not: that one
        // pre-fills a stored value that may legitimately be longer, and a
        // `maxLength` under it silently rewrites the animal's name. This form
        // starts empty.
        <TextField
          autoFocus
          label="Nombre"
          maxLength={PET_NAME_MAX}
          onChangeText={(name) => patch({ name })}
          placeholder="Pampa"
          required
          value={draft.name}
        />
      );

    case "especie":
      return (
        <>
          <Field label="Especie" required>
            <ChoiceGroup
              options={SPECIES_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              value={draft.species}
              // Changing species invalidates the breed: the catalogs do not
              // overlap, and leaving "Siamés" attached to a dog would be
              // refused by `resolveBreedForWrite` as an `invalid_request` with
              // no field to point at.
              onChange={(species) => patch({ species, breed: "" })}
            />
          </Field>
          <Field label="Sexo" required>
            <ChoiceGroup
              options={SEX_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              value={draft.sex}
              onChange={(sex) => patch({ sex })}
            />
          </Field>
        </>
      );

    case "raza":
      return <BreedPicker draft={draft} patch={patch} />;

    case "lugar":
      return (
        <LocalityPicker
          provinceCode={draft.provinceCode}
          localityName={draft.localityName}
          onSelect={(selection) =>
            patch({
              provinceCode: selection.provinceCode,
              localityName: selection.localityName,
              // A2-alta-asentar-03: WHICH San Martín. The picker shows the
              // department so the person can tell two homonyms apart; without
              // the id the server resolved the NAME and stored the
              // alphabetically first department regardless of the row tapped.
              localityIndecId: selection.localityIndecId,
            })
          }
        />
      );

    case "detalles":
      return (
        <>
          <Body>Nada de esto es obligatorio. Se puede completar después.</Body>
          <View style={styles.pair}>
            <View style={styles.pairCell}>
              <TextField
                accessibilityLabel="Años"
                inputMode="numeric"
                label="Años"
                mono
                onChangeText={(ageYears) => patch({ ageYears })}
                value={draft.ageYears}
              />
            </View>
            <View style={styles.pairCell}>
              <TextField
                accessibilityLabel="Meses"
                inputMode="numeric"
                label="Meses"
                mono
                onChangeText={(ageMonths) => patch({ ageMonths })}
                value={draft.ageMonths}
              />
            </View>
          </View>
          <TextField
            accessibilityLabel="Color"
            label="Color"
            maxLength={PET_COLOR_MAX}
            onChangeText={(color) => patch({ color })}
            placeholder="Atigrado, negro, blanco y marrón…"
            value={draft.color}
          />
          {/* NO `maxLength`, and this field is the reason the rule above has a
              condition on it (L2-10). The cap here was `String(999.99).length`,
              six — the widest string the column can hold. `Nombre` argues two
              lines up that truncating is only safe where it cannot rewrite what
              somebody meant, and a DECIMAL is exactly where it can: `123,456`
              became `123,45`, a different weight, still plausible, with nothing
              on screen to show that four hundred and fifty-six grams had been
              cut off. No cap can be safe here — every one of them leaves a
              prefix that parses. `WEIGHT_INVALID` from the contract says no out
              loud instead, which is the same trade `RecuperarScreen` makes for
              the one-time code.

              The placeholder shows the COMMA on purpose — `inputMode="decimal"`
              puts one under an Argentine thumb, the contract normalises it to a
              dot, and an example with a point would be teaching the wrong habit
              for the sake of the database. */}
          <TextField
            accessibilityLabel="Peso aproximado en kilos"
            inputMode="decimal"
            label="Peso aproximado (kg)"
            mono
            onChangeText={(estimatedWeightKg) => patch({ estimatedWeightKg })}
            placeholder="12,5"
            value={draft.estimatedWeightKg}
          />
          <Field label="¿Cómo llegó a tu casa?">
            <ChoiceGroup
              options={ACQUISITION_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              value={draft.acquisitionMethod}
              onChange={(acquisitionMethod) => patch({ acquisitionMethod })}
            />
          </Field>
        </>
      );

    case "confirmar":
      return (
        <Card title="Revisá antes de registrar">
          <Row label="Nombre" value={draft.name.trim() || "—"} />
          <Row label="Especie" value={draft.species ? speciesLabel(draft.species) : "—"} />
          <Row label="Raza" value={draft.breed.trim() || "Sin registrar"} />
          <Row label="Localidad" value={draft.localityName || "—"} />
          <Row label="Provincia" value={draft.provinceCode || "—"} />
          <Row
            label="Edad"
            value={
              draft.ageYears || draft.ageMonths
                ? `${draft.ageYears || 0} años ${draft.ageMonths || 0} meses`
                : "Sin registrar"
            }
          />
        </Card>
      );
  }
}

/**
 * The 409 answer.
 *
 * It explains WHAT the server noticed rather than just refusing, because the
 * server's own copy ("ya tenés una mascota registrada con ese nombre") is a
 * statement the user is in a position to judge and we are not: two dogs called
 * Negra in one house is a real thing.
 *
 * "Registrar igual" re-sends with `duplicateOverride: true` and — critically —
 * the SAME idempotency key. See pets/idempotency.ts.
 */
function DuplicateDialog({
  name,
  busy,
  onConfirm,
  onCancel,
}: {
  name: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Card title="¿Es la misma mascota?">
      <Body>
        {`Ya tenés registrada una mascota llamada ${name || "así"}, de la misma especie y sexo. Si es la misma, no hace falta registrarla de nuevo.`}
      </Body>
      <Body>Si de verdad son dos animales distintos, seguí adelante.</Body>
      <View style={styles.dialogActions}>
        <PrimaryButton
          label={busy ? "Registrando…" : "Registrar igual"}
          disabled={busy}
          onPress={onConfirm}
        />
        <SecondaryButton label="Cancelar" disabled={busy} onPress={onCancel} />
      </View>
    </Card>
  );
}

/** The breed picker: the contract's catalog, filtered as you type. */
function BreedPicker({
  draft,
  patch,
}: {
  draft: PetDraft;
  patch: (fields: Partial<PetDraft>) => void;
}) {
  const [query, setQuery] = useState("");
  const options = useMemo(() => breedsForSpecies(draft.species), [draft.species]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches =
      needle.length === 0 ? options : options.filter((b) => b.toLowerCase().includes(needle));
    // Capped, not scrolled forever: 12 rows is a decision, 180 is a list the
    // user has to read.
    return matches.slice(0, 12);
  }, [options, query]);

  // A PICKER WITH A CHOICE SHOWS THE CHOICE, NOT THE CATALOGUE. Reported from a
  // real Android on 2026-09-11: after tapping a breed the chip appeared AND the
  // twelve filtered rows stayed below it AND the field kept the typed text.
  // Three representations of one decision, stacked — and the rows pushed
  // "Continuar" off the bottom, so the person could neither see that the choice
  // had registered nor reach the way forward.
  //
  // The list was not staying open "in case you change your mind": that has its
  // own control and it says "Quitar".
  if (draft.breed) {
    return (
      <>
        <Body>La raza es opcional. Si no la sabés, seguí sin elegir.</Body>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Raza elegida: ${draft.breed}. Tocá para quitarla.`}
          onPress={() => {
            // The query goes with it — reopening the picker on the leftovers of
            // the search that found the PREVIOUS answer is its own confusion.
            setQuery("");
            patch({ breed: "" });
          }}
          style={styles.selected}
        >
          <Text style={styles.selectedLabel}>{draft.breed}</Text>
          <Text style={styles.selectedClear}>Quitar</Text>
        </Pressable>
      </>
    );
  }

  return (
    <>
      <Body>La raza es opcional. Si no la sabés, seguí sin elegir.</Body>
      <TextField
        accessibilityLabel="Buscar raza"
        autoCapitalize="none"
        label="Buscar raza"
        onChangeText={setQuery}
        placeholder="Escribí para filtrar"
        value={query}
      />
      {filtered.length === 0 ? (
        <Body>No encontramos esa raza en el catálogo. Podés dejarla vacía.</Body>
      ) : (
        filtered.map((breed) => (
          <Pressable
            accessibilityRole="button"
            key={breed}
            onPress={() => patch({ breed })}
            style={styles.option}
          >
            <Text style={styles.optionLabel}>{breed}</Text>
          </Pressable>
        ))
      )}
    </>
  );
}

/**
 * A label over something that is NOT a text input — a choice group, mostly.
 *
 * `TextField` owns its own label, so this is only for the controls the kit does
 * not wrap. It uses the kit's `FieldLabel` so the two kinds of field wear the
 * identical mono uppercase anatomy; a hand-rolled label here is how the two
 * would drift apart by one weight and half a pixel of tracking.
 */
function Field({
  label,
  required = false,
  children,
}: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <FieldLabel required={required}>{label}</FieldLabel>
      {children}
    </View>
  );
}

function ChoiceGroup({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    // CA-1: `radiogroup` on the container, and `checked` — not `selected` — on
    // each radio. A radio whose state is only `selected` is announced by
    // TalkBack and VoiceOver as an un-checkable control: the person hears which
    // pill has focus and never hears which one is CHOSEN. `checked` is the
    // state a radio has; `selected` is the one a tab or a list row has.
    <View accessibilityRole="radiogroup" style={styles.choices}>
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked }}
            key={option.value}
            onPress={() => onChange(option.value)}
            style={[styles.choice, checked ? styles.choiceSelected : null]}
          >
            <Text style={checked ? styles.choiceSelectedLabel : styles.choiceLabel}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  masthead: { gap: SPACE.xs },
  field: { alignSelf: "stretch" },
  pair: { flexDirection: "row", gap: SPACE.md },
  pairCell: { flex: 1 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.sm },
  // Pills, like every other button in this design (see RADIUS in theme.ts) —
  // a choice IS a button, and giving it its own geometry is how a fourth radius
  // gets into a codebase.
  choice: {
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.button,
    paddingHorizontal: SPACE.lg,
    paddingVertical: SPACE.sm + 2,
    // CA-2: the padding alone left these pills a few points under the 44pt
    // floor every other control in the kit honours. `justifyContent` keeps the
    // label centred once the box is taller than its text.
    minHeight: TOUCH_TARGET,
    justifyContent: "center",
  },
  choiceSelected: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  choiceLabel: { fontFamily: FONTS.sansSemibold, color: COLORS.ink, fontSize: TYPE.md },
  choiceSelectedLabel: { fontFamily: FONTS.sansSemibold, color: COLORS.surface, fontSize: TYPE.md },
  option: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.control,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.md,
  },
  optionLabel: { fontFamily: FONTS.sans, color: COLORS.ink, fontSize: TYPE.base },
  selected: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: COLORS.accent,
    borderRadius: RADIUS.control,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.md,
  },
  selectedLabel: { fontFamily: FONTS.sansSemibold, color: COLORS.surface, fontSize: TYPE.base },
  selectedClear: { fontFamily: FONTS.sansMedium, color: COLORS.surface, fontSize: TYPE.md },
  dialogActions: { gap: SPACE.sm, marginTop: SPACE.sm },
  nav: { gap: SPACE.sm, marginTop: SPACE.lg },
  blockedReason: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.base,
    color: COLORS.inkMuted,
    marginTop: SPACE.lg,
  },
});
