// EDITAR — the animal's own data, and who to call when something happens to it.
//
// ONE SCREEN, TWO FORMS, TWO SAVE BUTTONS, and the split is not cosmetic. The
// two halves are authorized by different rules and land in different places:
//
//   · DATOS writes `pets.name`/`breed`/`color` and appends a bundled
//     `pet_profile_updated` to the animal's ledger. It is a FACT about the
//     animal, so the correction is itself an entry — which is why the copy under
//     the button says the change is recorded rather than pretending an edit is
//     invisible.
//   · CONTACTOS writes four override columns and appends nothing, because they
//     are a preference of the person, not a fact about the pet. They are also
//     the TITULAR's own vet and phone: a co-owner and a foster hold the animal
//     and do not get them, which is why this half can be absent while the other
//     is present.
//
// A single "Guardar" would have had to pick one of those two truths for both,
// and would have posted the titular's contacts on behalf of somebody who may
// not touch them.
//
// EVERY AFFORDANCE COMES FROM `capabilities`, NEVER FROM "is this my pet". The
// server sends two booleans and this screen renders the REASON in place of the
// form when either is false. It never renders a control that can only be
// refused, and it never derives a rule of its own — see the view-model header.
//
// THE BREED PICKER APPENDS THE STORED VALUE when the catalog does not carry it
// (`breedChoicesFor`). That is the QA A5 grandfather rule made visible: without
// it, an owner whose animal is recorded as a breed the catalog has since dropped
// would have no way to keep it, and correcting the NAME would silently take the
// breed with it.
//
// THE NAME AND COLOUR CAPS ARE GRANDFATHERED THE SAME WAY, and they have to be
// twice over. `pets.name` and `pets.color` are unbounded `text` with no cap
// anywhere in the web's writer, so longer values already exist; a fixed
// `maxLength` would TRUNCATE such a name into the input and the next save would
// store the shortened one, while a fixed refusal on the way back would leave
// that owner unable to correct the COLOUR either, because this form posts both.
// `identityFieldCaps` handles the first half and `buildIdentityEdit`, given the
// server's own values, the second.

import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { PetProfileEditV1 } from "@dim/contract/api";
import { PET_SPECIES, type PetProfileCommandInput, type PetSpecies } from "@dim/contract/input";

import type { ApiResult } from "../api/client";
import { fetchPetProfileEdit, sendPetProfileCommand } from "../api/endpoints";
import { apiErrorMessage } from "../api/error-copy";
import { sessionPort } from "../auth/session-store";
import { Body, Card, Loading } from "../ui/components";
import { FONTS } from "../ui/fonts";
import {
  Callout,
  Choice,
  PrimaryButton,
  Screen,
  SecondaryButton,
  TextField,
  Title,
} from "../ui/kit";
import { movePetRoute } from "../ui/routes";
import { COLORS, SPACE, TOUCH_TARGET, TYPE } from "../ui/theme";
import { sameDraft } from "../ui/use-draft-dirty";
import { useDraftDiscardGuard } from "../ui/use-draft-discard-guard";
import { useReturnKeyChain } from "../ui/use-return-key-chain";

import {
  type EmergencyDraft,
  FIELD_LIMITS,
  type IdentityDraft,
  accountFallbackLabel,
  breedChoicesFor,
  buildCorrectSpecies,
  buildEmergencyContacts,
  buildIdentityEdit,
  contactsBlockedReason,
  emergencyDraftFrom,
  identityBlockedReason,
  identityDraftFrom,
  identityFieldCaps,
  savedLabel,
  speciesBlockedReason,
  speciesDraftFrom,
} from "./pet-profile-edit-view-model";
import { speciesLabel } from "./species";

/**
 * One sentence per failure arm. No arm falls through to a generic shrug, and
 * none of them quotes anything the server sent.
 */
function failureMessage(result: ApiResult<unknown>): string {
  switch (result.outcome) {
    case "api-error":
      return apiErrorMessage(result.code);
    case "unsupported-version":
      return "Esta versión de la app no puede leer esta pantalla. Actualizá la app.";
    case "malformed":
      return "La respuesta del servidor no se pudo leer.";
    case "unreachable":
      return "No pudimos conectarnos. Revisá tu conexión.";
    default:
      return "No pudimos abrir los datos de la mascota.";
  }
}

type ScreenState =
  | { phase: "loading" }
  | { phase: "ready"; view: PetProfileEditV1 }
  | { phase: "failed"; message: string };

/** What just happened, for the line above the forms. */
type Notice = { tone: "ok" | "err"; message: string } | null;

export function PetProfileEditScreen({ publicToken }: { publicToken: string }) {
  const router = useRouter();
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState<IdentityDraft | null>(null);
  const [contacts, setContacts] = useState<EmergencyDraft | null>(null);
  const [species, setSpecies] = useState<PetSpecies | null>(null);
  const [breedQuery, setBreedQuery] = useState("");
  // One return-key chain per SAVE GROUP; the BreedPicker between the two
  // identity fields is deliberately outside both (see use-return-key-chain).
  // Called HERE, above the loading/failed early returns — hooks may not sit
  // below a conditional return.
  const identityChain = useReturnKeyChain(2);
  const contactsChain = useReturnKeyChain(4);

  // THE BACK GESTURE MAY NOT DISCARD AN EDIT (A2-alta-asentar-08).
  //
  // TWO GROUPS, ONE QUESTION. This screen saves identity and contacts
  // separately, so somebody may have a saved identity and an unsaved phone
  // number — and the guard has to fire for either. The baseline is the SERVER'S
  // payload rather than a value captured at mount, which on this screen is
  // strictly better than a ref: `load` re-seeds both drafts after every landed
  // save (the picker resolves "pitbull" to "Pit Bull Terrier"), so "dirty" means
  // "differs from what is stored" and goes back to clean when a save lands.
  const storedContacts = state.phase === "ready" ? emergencyDraftFrom(state.view) : null;
  const dirty =
    state.phase === "ready" &&
    ((identity !== null && !sameDraft(identityDraftFrom(state.view), identity)) ||
      // `emergencyDraftFrom` is nullable: a viewer this payload does not carry
      // contacts for has no baseline, and no form to have typed into either.
      (contacts !== null && storedContacts !== null && !sameDraft(storedContacts, contacts)) ||
      // A species chip moved off the animal's own is a correction not yet sent.
      species !== speciesDraftFrom(state.view));
  useDraftDiscardGuard(dirty);

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    const result = await fetchPetProfileEdit(sessionPort, publicToken);
    if (result.outcome === "ok") {
      setState({ phase: "ready", view: result.payload });
      // THE DRAFTS ARE SEEDED FROM THE SERVER ON EVERY LOAD, including the
      // re-read after a save. A form that kept its own state across a reload
      // would keep showing what the person typed even when the server
      // normalised it — the breed picker resolves "pitbull" to "Pit Bull
      // Terrier", and the field has to end up saying what was actually stored.
      setIdentity(identityDraftFrom(result.payload));
      setContacts(emergencyDraftFrom(result.payload));
      setSpecies(speciesDraftFrom(result.payload));
      return;
    }
    setState({ phase: "failed", message: failureMessage(result) });
  }, [publicToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (input: PetProfileCommandInput) => {
      setBusy(true);
      setNotice(null);
      const result = await sendPetProfileCommand(sessionPort, publicToken, input);
      setBusy(false);
      if (result.outcome !== "ok") {
        setNotice({ tone: "err", message: failureMessage(result) });
        return;
      }
      setNotice({
        tone: "ok",
        message: savedLabel(result.payload.command, result.payload.changed),
      });
      // The ack is deliberately NOT the new state — re-read, so the form shows
      // what the server stored rather than what this screen sent.
      await load();
    },
    [load, publicToken],
  );

  if (state.phase === "loading") return <Loading label="Cargando los datos…" />;

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Editar datos</Title>
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load()} />
      </Screen>
    );
  }

  const view = state.view;
  const identityBlocked = identityBlockedReason(view);
  const contactsBlocked = contactsBlockedReason(view);
  const speciesBlocked = speciesBlockedReason(view);
  // GRANDFATHERED against what is stored, never the bare constant: a `TextInput`
  // truncates the value it is handed, so a fixed cap under an already-longer
  // name would shorten it on screen and the next save would write the shortened
  // one. See `identityFieldCaps`.
  const identityCaps = identityFieldCaps(view);

  return (
    // `keyboardAvoiding` because both forms are text inputs down a long scroll —
    // without it the keyboard covers the field being typed into.
    <Screen keyboardAvoiding>
      <Title>Editar datos</Title>

      {/* `Callout` renders its children into a bare <View>, so the text has to
          arrive already wrapped — a raw string there is invalid in React Native
          and simply never becomes a node anything can find. */}
      {notice !== null && (
        <Callout tone={notice.tone}>
          <Body>{notice.message}</Body>
        </Callout>
      )}

      <Card title="Datos de la mascota">
        {identityBlocked !== null || identity === null ? (
          <Callout tone="neutral">
            <Body>{identityBlocked ?? "No pudimos cargar los datos."}</Body>
          </Callout>
        ) : (
          <View style={styles.stack}>
            <Body>Cualquier cambio queda registrado en la libreta.</Body>
            <TextField
              {...identityChain(0)}
              label="Nombre"
              required
              maxLength={identityCaps.name}
              onChangeText={(name) => setIdentity({ ...identity, name })}
              value={identity.name}
            />
            <BreedPicker
              species={view.species}
              storedBreed={view.identity.breed}
              query={breedQuery}
              selected={identity.breed}
              onQuery={setBreedQuery}
              onSelect={(breed) => setIdentity({ ...identity, breed })}
            />
            <TextField
              {...identityChain(1)}
              label="Color"
              maxLength={identityCaps.color}
              onChangeText={(color) => setIdentity({ ...identity, color })}
              placeholder="Atigrado, negro con blanco en el pecho…"
              value={identity.color}
            />
            <PrimaryButton
              label="Guardar datos"
              disabled={busy}
              onPress={() => {
                const built = buildIdentityEdit(identity, view.identity);
                if (!built.ok) {
                  setNotice({ tone: "err", message: built.message });
                  return;
                }
                void run(built.input);
              }}
            />
          </View>
        )}
      </Card>

      {/* CORREGIR ESPECIE — the FULL-LOCK path, on this screen rather than on
          a route of its own. The web puts it one link away from its edit form
          (`corregir-especie/page.tsx`, "← Volver a editar") because a
          `?sheet=`-shaped page is what its router has; a stack navigator has no
          such thing, and a card here is where a person who came to fix "Perro"
          into "Gato" is already looking. The copy is the web sheet's,
          transcribed: its title, its "solo si se cargó mal" sentence, the field
          label and the button.

          IT IS NOT A FIELD OF THE DATOS FORM ABOVE, and that split is the
          server's (PO decision #40): `edit_identity` refuses the species and
          `correct_species` is its own command with its own event, its own breed
          clearing and its own PPP recomputation. Two buttons because they are
          two acts. */}
      <Card title="Corregir especie">
        {speciesBlocked !== null ? (
          <Callout tone="neutral">
            <Body>{speciesBlocked}</Body>
          </Callout>
        ) : (
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
              onSelect={setSpecies}
              disabled={busy}
            />
            <PrimaryButton
              label="Corregir especie"
              disabled={busy}
              onPress={() => {
                const built = buildCorrectSpecies(species);
                if (!built.ok) {
                  setNotice({ tone: "err", message: built.message });
                  return;
                }
                void run(built.input);
              }}
            />
          </View>
        )}
      </Card>

      {/* LA JURISDICCIÓN NO SE EDITA ACÁ, y el renglón existe para decirlo en el
          lugar donde alguien la va a buscar. Es FULL-LOCK en este camino (PO
          decision #40): `updatePetProfile` omite las tres columnas de su `SET`
          y la localidad se corrige registrando un MOVIMIENTO, que appendea un
          `movement_recorded` a la libreta y mueve las columnas que deciden qué
          autoridad responde por el animal.

          Es la misma entrada que la web pone en su propio formulario de editar
          (`components/PetForm.tsx`): un renglón bloqueado con la pista "La
          localidad se actualiza registrando un movimiento." y un enlace
          "Registrar mudanza". La copia se transcribe, no se inventa.

          NO SE DIBUJA LA LOCALIDAD ACTUAL, y esa es la diferencia con la web:
          `PetProfileEditV1` no la trae — es la lectura estrecha que un
          formulario escribe, no la cara del animal — y pedir `/pets/{token}`
          desde acá sería un segundo round trip para un renglón. La pantalla de
          mudanza la muestra, que es donde hace falta para leer una negativa. */}
      <Card title="Localidad">
        <View style={styles.stack}>
          <Body>La localidad se actualiza registrando un movimiento.</Body>
          <SecondaryButton
            label="Registrar mudanza"
            onPress={() => router.push(movePetRoute(publicToken))}
          />
        </View>
      </Card>

      <Card title="Contactos de emergencia">
        {contactsBlocked !== null || contacts === null ? (
          <Callout tone="neutral">
            <Body>{contactsBlocked ?? "No pudimos cargar los contactos."}</Body>
          </Callout>
        ) : (
          <View style={styles.stack}>
            <Body>
              Estos datos son de esta mascota. Si dejás un campo vacío usamos el de tu cuenta.
            </Body>

            <Text style={styles.groupTitle}>Veterinario</Text>
            <TextField
              {...contactsChain(0)}
              label="Nombre del veterinario"
              maxLength={FIELD_LIMITS.contactName}
              onChangeText={(preferredVetName) => setContacts({ ...contacts, preferredVetName })}
              value={contacts.preferredVetName}
            />
            <TextField
              {...contactsChain(1)}
              label="Teléfono del veterinario"
              keyboardType="phone-pad"
              maxLength={FIELD_LIMITS.contactPhone}
              onChangeText={(preferredVetPhone) => setContacts({ ...contacts, preferredVetPhone })}
              value={contacts.preferredVetPhone}
            />
            <Text style={styles.detail}>{accountFallbackLabel(view, "vet")}</Text>

            <Text style={styles.groupTitle}>Contacto de emergencia</Text>
            <TextField
              {...contactsChain(2)}
              label="Nombre del contacto"
              maxLength={FIELD_LIMITS.contactName}
              onChangeText={(emergencyContactName) =>
                setContacts({ ...contacts, emergencyContactName })
              }
              value={contacts.emergencyContactName}
            />
            <TextField
              {...contactsChain(3)}
              label="Teléfono del contacto"
              keyboardType="phone-pad"
              maxLength={FIELD_LIMITS.contactPhone}
              onChangeText={(emergencyContactPhone) =>
                setContacts({ ...contacts, emergencyContactPhone })
              }
              value={contacts.emergencyContactPhone}
            />
            <Text style={styles.detail}>{accountFallbackLabel(view, "emergency")}</Text>

            <PrimaryButton
              label="Guardar contactos"
              disabled={busy}
              onPress={() => {
                const built = buildEmergencyContacts(contacts);
                if (!built.ok) {
                  setNotice({ tone: "err", message: built.message });
                  return;
                }
                void run(built.input);
              }}
            />
          </View>
        )}
      </Card>
    </Screen>
  );
}

/**
 * The breed picker: the contract's catalog filtered as you type, with the
 * animal's stored value first when the catalog has lost it.
 *
 * The same shape the alta wizard uses, deliberately — a person who registered a
 * pet last week should meet the control they already know. What differs is the
 * grandfathered option, which `alta` has no use for: there is no stored value
 * on a pet that does not exist yet.
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
    // build 10, shot 102). An empty query used to mean "show the whole catalog",
    // so opening "Editar datos" drew twelve breeds inline under the filter box
    // and pushed COLOR and "Guardar datos" a full screen down — on the screen
    // whose job is editing four fields, not browsing a catalog. The alta
    // wizard's locality step already searches this way: the list is an ANSWER to
    // a query.
    //
    // NOT an empty list, though, and the difference is the grandfather rule this
    // picker exists for: the one row kept is the animal's STORED breed, so a
    // person who taps "Quitar" by accident can put back a value the catalog may
    // no longer contain — and which they would then have to spell from memory.
    if (needle.length === 0) {
      return storedBreed === null || storedBreed.length === 0 ? [] : [storedBreed];
    }
    // Capped, not scrolled forever: 12 rows is a decision, 180 is a list the
    // user has to read. The alta wizard's number, for the same reason.
    return options.filter((b) => b.toLowerCase().includes(needle)).slice(0, 12);
  }, [options, needle, storedBreed]);

  return (
    <View style={styles.stack}>
      <TextField
        // NO explicit accessibilityLabel (WCAG 2.5.3, carried from lote 1a's
        // LocalityPicker fix): the visible label is "Raza", so a voice user
        // saying "Buscar raza" named a control that did not exist under that
        // name. The placeholder still says what the field does.
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
        // "No encontramos esa raza" is an answer to a SEARCH. With nothing typed
        // there was no search, so an empty list says nothing rather than
        // reporting a failure the person did not cause.
        needle.length === 0 ? null : (
          <Body>No encontramos esa raza en el catálogo.</Body>
        )
      ) : (
        filtered.map((breed) => (
          <Pressable
            accessibilityRole="button"
            key={breed}
            onPress={() => onSelect(breed)}
            style={styles.option}
          >
            <Text style={styles.optionLabel}>{breed}</Text>
          </Pressable>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: SPACE.sm },
  groupTitle: {
    fontFamily: FONTS.sansSemibold,
    fontSize: TYPE.base,
    color: COLORS.ink,
    marginTop: SPACE.xs,
  },
  detail: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.inkMuted },
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
});
