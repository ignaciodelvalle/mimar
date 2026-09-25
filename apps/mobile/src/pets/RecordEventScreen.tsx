// ANOTAR — writing one of the asientos an owner may write, from the phone.
// (Renamed from "Asentar" on screen, U-2 native review — see `KindPicker`'s
// own comment. The FILE and its identifiers keep the old word where it is
// already load-bearing prose about the domain act of writing an asiento;
// only the on-screen verb changed.)
//
// SIX WHEN THIS SCREEN WAS BUILT, ELEVEN NOW: WU-L added visita veterinaria,
// información clínica, esterilización and microchip, and WU-M added síntoma —
// every web writer that appends a plain fact under the SAME guard the first six
// use and through the same idempotent insert. What is still missing from the
// picker is listed in `writers.ts`, with the evidence for each exclusion; the
// short of it is that mordedura opens a case, lost/found mutate status and have
// their own endpoints, and two others have no idempotency key to honour.
//
// SÍNTOMA IS THE ONE THAT DOES MORE THAN APPEND, and the screen says so before
// the form rather than after the write: its subtitle names the sanitary
// authority. The server decides everything about that fan-out off the free text
// — this form sends three fields and no disease, no signal and no recipient.
//
// IT APPENDS. Nothing here edits anything: every one of these lands as a new row
// on an append-only spine, and a mistake is corrected by appending a correction
// on top. `RECORD_IMMUTABILITY_NOTE` says so on every form, BEFORE the button,
// because a person about to write into a national registry should know that
// while they can still stop.
//
// ONE KIND IS NOT PICKED HERE. Ending a treatment needs the
// `medication_started` asiento it ends, and the only place a person already
// holds that identifier is that asiento's own screen — so that affordance lives
// there and arrives here with `sourceEventId` filled in. A picker would have to
// invent a list of open treatments from a second read, and a second read is a
// second source for something the ledger already says.
//
// ONE KEY PER FORM MOUNT, and the cost is the same one `idempotency.ts` argues
// for the alta and `EventDetailScreen` repeats for a correction: the key
// survives an EDIT, so a timeout whose first request committed will replay that
// first request and discard what was typed second. Accepted for the same reason
// — the alternative puts TWO asientos on an append-only spine for one act — and
// mitigated the same way: switching kinds remounts the form (a new key), and a
// finished write leaves the form rather than reusing it.
//
// NO ATTACHMENTS, AND THE REASON CHANGED. Every web form here offers a photo;
// this one still does not. It used to say the path was blocked because "a native
// upload needs a signed URL and that path is blocked" — that half is now false:
// `POST /pets/{token}/photo` is the ticket-then-confirm door, and
// `lib/infra/pet-photo-upload.ts` is a primitive an event attachment can reuse.
//
// AND ON 2026-09-10 THE OTHER HALF STOPPED BEING TRUE TOO, FOR EXACTLY ONE
// KIND. It said `POST .../events` takes no attachment, so wiring one would be a
// client offering a field the endpoint discards, and that the confirm step would
// have to know which event it is claiming for. The tatuaje kind is that work
// unit: the ASIENTO is the confirm, so there is no third call to teach anything
// to. The app stages the bytes with the pet photo's own ticket, names the staged
// object in the body, and the server claims it into `event-attachments` inside
// the same transaction that appends the event.
//
// SIXTEEN OF THE EIGHTEEN STILL SEND NO ATTACHMENT — D7 (2026-09-25) MOVED A
// SECOND ONE OFF THAT LIST. Their writers take `uploadedPath: null` and their
// web forms merely OFFER a file. Tatuaje's web action REFUSES a submission
// without one; seguimiento post-adopción's does not — its photo is OPTIONAL,
// same shape (`stagedPath`), same claim, but `null` is a valid answer rather
// than a refusal. See the contract's `tattoo` and `post_adoption_checkin`
// variants.
//
// WHICH MAKES THESE TWO THE FORMS THAT CANNOT OFFER A PHOTO IN EVERY BUILD.
// Choosing one needs `expo-image-picker`, a native module this build does not
// carry (`src/native/image-picker-port.ts`). Tatuaje still draws NO submit
// button at all where the port is unavailable — see the guard just below —
// because it has nothing to send without one; check-in's photo is optional, so
// its form still submits fine with just the text, and only the picker button
// itself is missing. The day the adapter ships, `setImagePickerPort()` runs at
// bootstrap and both light up with no change here.

import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image, StyleSheet, View } from "react-native";

import type { OwnerPetPppRegistryV1 } from "@dim/contract/api";
import {
  DEATH_CAUSES,
  DISPOSITION_METHODS,
  OWNER_MICROCHIP_REPLACE_REASONS,
  VET_CONTACT_VALUES,
} from "@dim/contract/input";
import { apiFailureMessage } from "../api/client";
import { fetchOwnerPetDetail, recordPetEvent } from "../api/endpoints";
import { getSessionState, sessionPort } from "../auth/session-store";
import { ASYNC_IMAGE_PICK_MARKER_STORE } from "../native/image-pick-marker-store";
import {
  type ImagePickResult,
  getImagePickerPort,
  pickImageSafely,
  recoverPendingPickSafely,
} from "../native/image-picker-port";
import { LocationPicker } from "../ui/LocationPicker";
import { Body, Card } from "../ui/components";
import { isoDayToLocalDate } from "../ui/date-input";
import {
  Callout,
  Choice,
  DateField,
  Eyebrow,
  LabelledDivider,
  ListRow,
  NO_KEYBOARD_MEMORY,
  PrimaryButton,
  Screen,
  SecondaryButton,
  TextField,
  TimeField,
  Title,
} from "../ui/kit";
import { credentialRoute } from "../ui/routes";
import { COLORS, RADIUS, SPACE } from "../ui/theme";
import { useIsDirty } from "../ui/use-draft-dirty";
import { useDraftDiscardGuard } from "../ui/use-draft-discard-guard";
import { useReturnKeyChain } from "../ui/use-return-key-chain";
import { useScrollToError } from "../ui/use-scroll-to-error";
import { LocalityPicker } from "./LocalityPicker";
import { QuickCaptureBox } from "./QuickCaptureBox";
import { bitePickedLocation } from "./bite-location";
import {
  type AcceptedImage,
  acceptPickedImage,
  petPhotoFailureMessage,
} from "./pet-photo-view-model";
import { stageTattooPhoto } from "./tattoo-photo-flow";

import { createAttemptSession } from "./idempotency";
import {
  BITE_SEVERITY_OPTIONS,
  BITE_VICTIM_KIND_OPTIONS,
  CLINICAL_SUB_KIND_OPTIONS,
  DEWORMING_TYPE_OPTIONS,
  type EventDraft,
  FREQUENCY_OPTIONS,
  NOTE_CATEGORY_OPTIONS,
  PREGNANCY_OUTCOME_OPTIONS,
  type PetFactsForMenu,
  RECORD_DONE_LABEL,
  RECORD_DUPLICATE_LABEL,
  RECORD_IMMUTABILITY_NOTE,
  RECORD_KINDS,
  RESTORED_DRAFT_TITLE,
  SAME_DAY_PROMPT_LABEL,
  STERILIZATION_PROCEDURE_OPTIONS,
  SYMPTOM_SEVERITY_OPTIONS,
  TATTOO_LOCATION_OPTIONS,
  type WritableKind,
  YES_NO,
  attestationRegistryOptions,
  biteSeverityLabel,
  biteVictimKindLabel,
  clinicalSubKindLabel,
  conditionalKinds,
  deathCauseLabel,
  deathDiseaseOptions,
  dewormingTypeLabel,
  diseaseLabel,
  dispositionMethodLabel,
  emptyDraft,
  frequencyLabel,
  inputCodeMessage,
  invalidFields,
  kindSubtitle,
  kindTitle,
  microchipReplaceReasonLabel,
  noteCategoryLabel,
  pregnancyOutcomeLabel,
  recordEventCta,
  restoredDraftNote,
  sterilizationProcedureLabel,
  symptomSeverityLabel,
  tattooLocationLabel,
  todayInAr,
  validateDraft,
  vetContactLabel,
  yesNoLabel,
} from "./record-event-view-model";
import { DISCARD_COPY, confirmDiscard } from "./use-discard-guard";
import { useEventDraft } from "./use-event-draft";

/** One sentence per failure arm. No arm may fall through to a generic shrug. */
/**
 * The signed-in person's id, or `null` when nobody is — read fresh rather
 * than subscribed to, the same choice `use-event-draft.ts`'s own
 * `currentOwnerId` makes: this route is behind `useGate`, so the session is
 * already resolved by the time this screen mounts. `null` here means "skip
 * the recovery marker" — see `pickImageSafely`'s own note on that arm
 * (T3-R4, 2026-09-22).
 */
function currentSessionUserId(): string | null {
  const state = getSessionState();
  return state.phase === "signed-in" ? state.user.id : null;
}

export function RecordEventScreen({
  publicToken,
  initialKind = null,
  sourceEventId = null,
}: {
  publicToken: string;
  /** Set when the caller already decided — the medication-end path does. */
  initialKind?: WritableKind | null;
  /** The `medication_started` asiento a medication END refers to. */
  sourceEventId?: string | null;
}) {
  const [kind, setKind] = useState<WritableKind | null>(initialKind);
  // LO QUE LA CAPTURA ENTENDIÓ, viajando del menú al formulario.
  //
  // VIVE ACÁ Y NO ADENTRO DEL FORMULARIO porque lo produce el menú, que es el
  // hermano de al lado. Se limpia con "Elegir otro tipo": un borrador de
  // arranque que sobreviviera a volver atrás llenaría el formulario SIGUIENTE
  // con campos que la persona dijo para el anterior.
  const [prefill, setPrefill] = useState<Partial<EventDraft>>({});

  if (kind === null) {
    return (
      <KindPicker
        publicToken={publicToken}
        onPick={(picked, values = {}) => {
          setPrefill(values);
          setKind(picked);
        }}
      />
    );
  }

  return (
    <EventForm
      // REMOUNTS ON A KIND CHANGE, which is what gives the new form its own
      // idempotency key. Without it, switching from Peso to Nota and submitting
      // would reuse the abandoned weighing's key and be deduped into silence.
      key={kind}
      kind={kind}
      publicToken={publicToken}
      sourceEventId={sourceEventId}
      prefill={prefill}
      onBack={
        initialKind === null
          ? () => {
              setPrefill({});
              setKind(null);
            }
          : null
      }
    />
  );
}

/**
 * The animal's own facts, for the rows that are a claim about it.
 *
 * `null` UNTIL THE READ ANSWERS, and that fourth state is the reason this is
 * not just `PetFactsForMenu`. `conditionalKinds` treats a null FIELD as "I
 * could not find out" and offers the row anyway — the right call once a read
 * has finished and come back degraded. Before it finishes, the same value would
 * mean something else entirely, and the menu would draw two rows and then take
 * one away while somebody is reaching for it. A row that appears late is fine;
 * a row that vanishes under a thumb is not.
 *
 * ONE READ, THE SAME ONE the PPP and disease pickers make. It is not free, and
 * it is paid once per visit to the picker rather than once per form.
 */
function useMenuFacts(publicToken: string): PetFactsForMenu | null {
  const [facts, setFacts] = useState<PetFactsForMenu | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const result = await fetchOwnerPetDetail(sessionPort, publicToken);
      if (!alive) return;
      if (result.outcome !== "ok") {
        // A FAILED READ STILL ANSWERS, with every fact unknown — which
        // `conditionalKinds` reads as "offer them". Leaving this at `null`
        // would hide the rows forever behind a network blip, and nothing on
        // screen would say a capability had gone missing.
        setFacts({
          sex: null,
          species: null,
          pregnancyStatus: null,
          postAdoptionCheckinPending: null,
        });
        return;
      }
      const identity = result.payload.identity;
      const status = result.payload.status;
      const checkin = result.payload.postAdoptionCheckin;
      setFacts({
        sex: identity.status === "ok" ? identity.data.sex : null,
        species: identity.status === "ok" ? identity.data.species : null,
        // A DEGRADED STATUS SECTION AND AN ANIMAL THAT WAS NEVER PREGNANT ARE
        // BOTH `null` HERE, and they must not be: the first means "unknown", the
        // second means "no follow-up open". They diverge in
        // `conditionalKinds` — unknown offers both halves, no-follow-up offers
        // only the start — so the section's own status is what separates them,
        // never the field's emptiness.
        pregnancyStatus: status.status === "ok" ? (status.data.pregnancyStatus ?? "none") : null,
        // ITS OWN SECTION, resolved by the route with its own budget, so a
        // degraded window read is `unavailable` here — "offer it" — while the
        // rest of the face is fine. `false` is the fact that withholds the row.
        postAdoptionCheckinPending: checkin.status === "ok" ? checkin.data.pending : null,
      });
    })();
    return () => {
      alive = false;
    };
  }, [publicToken]);

  return facts;
}

function KindPicker({
  publicToken,
  onPick,
}: {
  publicToken: string;
  /** `prefill` llega sólo desde la caja de captura; una fila no entiende nada. */
  onPick: (kind: WritableKind, prefill?: Partial<EventDraft>) => void;
}) {
  const facts = useMenuFacts(publicToken);
  // Empty until the read lands — see `useMenuFacts`. The ten fixed rows draw
  // immediately either way; these are additive.
  const conditional = facts === null ? [] : conditionalKinds(facts);
  return (
    // `keyboardAvoiding` DESDE QUE HAY UNA CAJA DE TEXTO ACÁ. Sin esto el
    // teclado tapa la tarjeta que dice qué se entendió, que es justo lo que hay
    // que leer antes de apretar el botón que abre el formulario. El ScrollView
    // del kit ya trae `keyboardShouldPersistTaps="handled"`, así que ese botón
    // se puede tocar con el teclado abierto y sin un toque previo para cerrarlo.
    <Screen keyboardAvoiding>
      {/* "Anotar", not "Asentar" (U-2, native review). The credential's front
          pill (`OwnerFace.tsx`) and this picker are the exact same act reached
          from two doors, and the two doors used to say two different verbs —
          which reads as two different features to someone who has only ever
          used one of the two faces. "Anotar" is the front's word, kept here
          because the front is the surface most people meet first. The domain
          verb the death form uses ("Asentar el fallecimiento",
          `recordEventCta`) is deliberately untouched: that CTA is not naming
          this entry point, it is naming the one act that closes a life
          record, and its own comment there says why "registrar" was wrong
          for it. */}
      <View style={styles.header}>
        <Eyebrow>Libreta sanitaria</Eyebrow>
        <Title>Anotar</Title>
        <Body>¿Qué querés registrar?</Body>
      </View>
      {/* ARRIBA DE LAS FILAS Y SIN REEMPLAZARLAS. Ver la cabecera de
          `QuickCaptureBox`: es el camino rápido, y un camino rápido abajo de
          trece filas no lo es; y la lista sigue siendo la única enumeración
          completa de lo que se puede escribir. */}
      <QuickCaptureBox facts={facts} onOpen={onPick} />
      <LabelledDivider label="o elegí el tipo" />
      {RECORD_KINDS.map((kind) => (
        <SecondaryButton
          key={kind}
          label={kindTitle(kind)}
          accessibilityHint={kindSubtitle(kind)}
          onPress={() => onPick(kind)}
        />
      ))}
      {/* AFTER THE TEN AND NOT MIXED INTO THEM. The fixed list is ordered by
          how often the act happens (see `RECORD_KINDS`), and a row that appears
          a beat later must not push that order around under somebody's thumb.
          Appending is the only insertion point where a late arrival moves
          nothing that was already on screen. */}
      {conditional.map((kind) => (
        <SecondaryButton
          key={kind}
          label={kindTitle(kind)}
          accessibilityHint={kindSubtitle(kind)}
          onPress={() => onPick(kind)}
        />
      ))}
      {/* Eleven pills and then this. It is NOT one of the eleven — ending a
          treatment happens on the asiento that started it, deliberately (see
          this file's header) — but until 2026-09-03 it was drawn as a `Card`,
          a bordered box among stretched pills, because the kit had no row that
          could say "this is here, and it is not a destination". It has one
          now. Same list, same rhythm, visibly not tappable, and the caption
          says where the real control lives. */}
      <ListRow
        label="Terminar una medicación"
        caption='Se hace desde el asiento del inicio del tratamiento, en la libreta: "Terminar medicación".'
      />
    </Screen>
  );
}

type FormPhase =
  | { phase: "editing" }
  | { phase: "sending" }
  /** The soft same-day gate. The same body, resent with the override. */
  | { phase: "confirming-same-day" }
  | { phase: "done"; wasDuplicate: boolean };

/**
 * The registries THIS animal's jurisdiction names for a PPP attestation.
 *
 * READ IN THE BACKGROUND, AND THE FORM NEVER WAITS FOR IT. The attestation
 * field is already correct without this read: it falls back to
 * `DANGEROUS_BREED_REGISTRIES`, which is the same set `buildRegistryOptions`
 * uses on the web when a jurisdiction has loaded none — and the empty payload
 * is the common case, because `ppp_attestation_required_registries` defaults to
 * an empty list everywhere. So there is no loading state and no error state
 * here: a failed read leaves the person with the national list, which is what
 * the web would have shown them anyway.
 *
 * WHAT IT ADDS is the half a constant cannot have. The rule is admin-editable
 * and resolved per province and locality; without this read, an admin loading
 * CABA's registries would change what a web owner sees and not what an app
 * owner sees.
 *
 * ONLY FOR THE KINDS THAT ASK. Every other form on this screen would be
 * paying for a pet-detail read it has no field for.
 *
 * THE TWO PHOTO KINDS' NAME (T3-R4, 2026-09-22; D7 added the second,
 * 2026-09-25): the recovered-photo confirmation (`TattooPhotoField`'s
 * `review` phase) names the pet it is about to stage a photo for, so a person
 * is not asked to confirm a bare thumbnail with nothing saying whose
 * credential — or whose check-in — it is headed to. `petName` is the only
 * field either kind reads off this hook.
 */
function useOwnerPetFacts(kind: WritableKind, publicToken: string) {
  const [registries, setRegistries] = useState<readonly OwnerPetPppRegistryV1[]>([]);
  const [species, setSpecies] = useState<string | null>(null);
  const [petName, setPetName] = useState<string | null>(null);
  // M17: where the bite map opens — the animal's own locality, by search.
  const [petPlace, setPetPlace] = useState<string | null>(null);

  useEffect(() => {
    // FIVE KINDS ASK, and one read answers all of them: the PPP form needs
    // the jurisdiction's registries, the death form needs the animal's
    // SPECIES to filter the disease catalog, tattoo and check-in (D7) need the
    // animal's NAME for their recovered-photo confirmation, and the bite map
    // (M17) opens on the animal's own locality. Every other form would be
    // paying for a pet-detail round trip it has no field for.
    if (
      kind !== "dangerous_breed_attestation" &&
      kind !== "death" &&
      kind !== "tattoo" &&
      kind !== "post_adoption_checkin" &&
      kind !== "bite"
    ) {
      return;
    }
    let alive = true;
    void (async () => {
      const result = await fetchOwnerPetDetail(sessionPort, publicToken);
      // THE GUARD IS AGAINST AN UNMOUNTED FORM, not against a stale read: this
      // fires once per mount and there is no second request to supersede it.
      if (!alive || result.outcome !== "ok") return;
      // `identity` is ok on every healthy read; a degraded section leaves the
      // species and name null. `deathDiseaseOptions` reads a null species as
      // 'no species to filter by' and answers with the full catalog — the same
      // widening the server applies. Never an empty picker. A null NAME just
      // means the tattoo confirmation falls back to a pet-less sentence; see
      // `TattooPhotoField`.
      if (result.payload.identity.status === "ok") {
        setSpecies(result.payload.identity.data.species);
        setPetName(result.payload.identity.data.name);
        const { jurisdictionLocality, jurisdictionProvince } = result.payload.identity.data;
        setPetPlace(
          [jurisdictionLocality, jurisdictionProvince].filter((part) => part).join(", ") || null,
        );
      }
      const section = result.payload.pppRegistries;
      // `unavailable` is a read that did not answer and `null` is an animal
      // outside the regime. Neither is "this jurisdiction names no registry",
      // and only that last one may replace the fallback.
      if (section.status !== "ok" || section.data === null) return;
      setRegistries(section.data);
    })();
    return () => {
      alive = false;
    };
  }, [kind, publicToken]);

  return { registries, species, petName, petPlace };
}

/**
 * Donde esta la foto — del tatuaje, o (D7, 2026-09-25) del check-in — los
 * unicos dos archivos que este formulario puede mandar. Un solo `useState`
 * para los dos kinds: nunca coexisten, porque `EventForm` remonta con `key={kind}`
 * al cambiar de tipo (ver el comentario de ese remount).
 *
 * FUERA DEL BORRADOR A PROPOSITO. `EventDraft` es texto serializable que
 * `useIsDirty` compara campo por campo, y un `Blob` no es ninguna de las dos
 * cosas. Ademas el borrador se compara para preguntar "¿salir sin guardar?", y
 * unos bytes elegidos son justamente algo que la persona no quiere perder por
 * un gesto de atras — el guard ya cubre eso mirando el resto.
 *
 * `ready` GUARDA EL `stagedPath` Y NO LOS BYTES. Una vez subidos, lo unico que
 * el asiento necesita es el nombre del objeto, y ese nombre no es una
 * capacidad: el servidor vuelve a derivar el prefijo que le corresponde a ESTA
 * mascota y rechaza cualquier otro.
 */
type TattooPhotoState =
  | { phase: "none" }
  /** El selector del sistema esta arriba. Su UI es del modulo, no de esta pantalla. */
  | { phase: "picking" }
  /**
   * T3-R4 (2026-09-22): SOLO UNA FOTO RECUPERADA PASA POR ACA. Una eleccion
   * EN VIVO sigue subiendo directo — "elegir y subir son un solo gesto" es
   * deliberado para esa, ver mas abajo — pero una foto que Android sostuvo
   * desde antes de este montaje no tiene ningun gesto detras, y por eso no
   * puede auto-subirse ni auto-mandarse: exige un toque explicito, con el
   * nombre de la mascota en la pantalla, antes de que un solo byte salga del
   * telefono. `TattooPhotoField` dibuja esto como confirmacion, no como
   * "listo".
   */
  | { phase: "review"; image: AcceptedImage }
  | { phase: "uploading"; image: AcceptedImage }
  | { phase: "ready"; previewUri: string | null; stagedPath: string }
  | { phase: "failed"; message: string };

function EventForm({
  kind,
  publicToken,
  sourceEventId,
  prefill,
  onBack,
}: {
  kind: WritableKind;
  publicToken: string;
  sourceEventId: string | null;
  /**
   * Lo que la caja de captura entendió de una frase, o `{}` si se llegó acá
   * tocando una fila. Ver dónde se aplica, justo abajo: el LUGAR es la decisión.
   */
  prefill: Partial<EventDraft>;
  /** `null` when this form is the whole screen and there is nothing to go back to. */
  onBack: (() => void) | null;
}) {
  const router = useRouter();
  const {
    registries: pppRegistries,
    species,
    petName,
    petPlace,
  } = useOwnerPetFacts(kind, publicToken);
  // EL PREFILL ENTRA EN EL INICIALIZADOR, Y ESO ES TODO LO QUE HACE FALTA PARA
  // QUE LOS DOS GUARDIANES DE ESTA PANTALLA SIGAN DICIENDO LA VERDAD.
  //
  // `useIsDirty` y `useEventDraft` comparan contra el PRIMER valor que vieron,
  // cada uno capturado en un ref en su primer render. Si el prefill entra acá,
  // ese primer valor YA lo incluye, y entonces:
  //
  //   · Volver atrás de una captura equivocada no pregunta "¿Salir sin
  //     guardar?". Nadie escribió nada: los campos los puso la app.
  //   · No se guarda ningún borrador de un formulario que sólo se abrió. El
  //     autoguardado arranca cuando el valor DIFIERE del inicial, así que una
  //     captura que nadie tocó no deja papel escrito en el teléfono, y no vuelve
  //     días después como "recuperamos lo que estabas escribiendo" sobre un
  //     formulario que la persona nunca eligió.
  //
  // Aplicarlo con un `useEffect` después del montaje, que es la forma obvia,
  // rompe las dos cosas a la vez: el prefill llegaría como un CAMBIO sobre un
  // formulario vacío, o sea indistinguible de alguien tipeando.
  const [draft, setDraft] = useState<EventDraft>(() => ({ ...emptyDraft(), ...prefill }));
  const [state, setState] = useState<FormPhase>({ phase: "editing" });
  const [error, setError] = useState<string | null>(null);
  // The fields the last refusal was about, for the red border (forms-F3).
  // Cleared per field as the person edits it, so the box stops being red the
  // moment they touch it rather than after the next submit.
  const [invalid, setInvalid] = useState<ReadonlySet<keyof EventDraft>>(() => new Set());

  // A DISEASE PICKED BEFORE THE SPECIES ARRIVED MAY NOT SURVIVE IT.
  //
  // THE SAME DEFECT AS THE REGISTRY BELOW, REINTRODUCED THE SAME DAY three
  // screens down, which is the argument for this comment existing. The picker
  // shows the WHOLE catalog until `useOwnerPetFacts` answers, then narrows to
  // the animal's species. Somebody on a slow link taps "Toxoplasmosis" — cat
  // only, and REPORTABLE — the read lands with `species: "dog"`, the chip
  // vanishes, and the draft keeps it. `validateDraft` passes (the contract only
  // asks that the code be in the catalog, not that it fit the species) and
  // `resolveDeathReportable` then raises an authority signal for a disease that
  // animal cannot have.
  useEffect(() => {
    if (kind !== "death") return;
    if (species === null) return;
    const offered = deathDiseaseOptions(species);
    setDraft((current) =>
      current.diseaseCode.length > 0 && !offered.some((d) => d.id === current.diseaseCode)
        ? { ...current, diseaseCode: "" }
        : current,
    );
  }, [kind, species]);

  // A REGISTRY PICKED FROM THE FALLBACK MAY NOT SURVIVE THE JURISDICTION'S OWN
  // LIST ARRIVING. `usePppRegistries` swaps the chips mid-form; before this
  // effect, a person on a slow link who tapped "CABA · Ley 4078" and then kept
  // filling the form was left with a chip row that had silently lost its
  // highlight — scrolled out of view — and a draft that still carried
  // `caba_4078`. The form's own validation passes (the contract asks only for a
  // non-empty string), so the refusal arrived from the SERVER, as
  // `PPP_REGISTRY_NOT_ALLOWED`, on a value the app itself had offered.
  //
  // Clearing it is the honest repair: the draft then agrees with what is on
  // screen, and the next submit is refused LOCALLY with "elegí un registro" —
  // a sentence about a choice they can make, in the place they make it.
  useEffect(() => {
    if (kind !== "dangerous_breed_attestation") return;
    const offered = attestationRegistryOptions(pppRegistries);
    setDraft((current) =>
      current.registry.length > 0 && !offered.some((r) => r.id === current.registry)
        ? { ...current, registry: "" }
        : current,
    );
  }, [kind, pppRegistries]);
  const { anchorRef: errorAnchor, scrollRef } = useScrollToError(error);
  // THE BACK GESTURE MAY NOT DISCARD TEN FILLED-IN FIELDS (A2-alta-asentar-08).
  // Somebody finishing medicación·inicio nudges the Android back gesture while
  // dismissing the keyboard and lands on the libreta with all of it gone.
  //
  // `useIsDirty` and NOT `draft !== emptyDraft()`: those are two different
  // objects, so the comparison is true on mount and would ask the question of
  // everyone who merely opened the form — see that hook's header. `done` clears
  // it because the asiento is on the server and the screen is an ack.
  const dirty = useIsDirty(draft) && state.phase !== "done";
  // `DISCARD_COPY.asiento` AND NOT `.form` SINCE 2026-09-17, because this is the
  // one writer screen where leaving no longer loses anything: the draft is kept
  // on the phone and offered back. See that entry for why the other ten screens
  // keep the old sentence.
  const { allowLeave } = useDraftDiscardGuard(dirty, DISCARD_COPY.asiento);
  // WHAT SOMEBODY TYPED SURVIVES BEING INTERRUPTED (PO decision 2026-09-16).
  //
  // A LOCAL DRAFT, AND NOT A SEND QUEUE. That ordering is the decision itself,
  // not an increment of it: a queue would have to decide what happens when a
  // retry is refused, and on an append-only spine a retry done wrong puts TWO
  // asientos in the ledger for one act. Nothing below can send anything. The
  // only thing that writes an asiento is the button at the bottom of this form,
  // pressed by a person who is looking at it, on `attempt.current.key()`.
  const { restored, discardRestored, forgetOnSuccess } = useEventDraft({
    publicToken,
    kind,
    // KEYED WITH THE SOURCE ASIENTO TOO, for the one kind that has one:
    // abandoning the end of treatment A and later opening the end of treatment
    // B must not restore A's "Motivo" under B's form. See `eventDraftKey`.
    sourceEventId,
    draft,
    onRestore: setDraft,
  });
  // ONE key for this whole asiento. `useRef` and not `useState` because a
  // re-render must not be able to produce a different key, and because nothing
  // renders from it. Never `restart()`-ed: this form IS one attempt, and the
  // same-day confirm below is the SAME attempt resent.
  const attempt = useRef(createAttemptSession());
  const [photo, setPhoto] = useState<TattooPhotoState>({ phase: "none" });
  // F-10 (native review): "Falta la foto del tatuaje…" stayed on screen after
  // the photo it was complaining about finished uploading. `set()` above
  // clears a stale field error the moment the DRAFT changes, but the photo is
  // its own state — not a draft field, per `invalidFields`'s own comment on
  // `TATTOO_PHOTO_REQUIRED` — so nothing was watching it. Cleared only when
  // the CURRENT message is exactly the ONE this kind's own refusal would show
  // — `TATTOO_PHOTO_REQUIRED` for tattoo, `CHECKIN_PHOTO_INVALID` for check-in
  // (D7) — so an unrelated refusal (`TATTOO_CODE_REQUIRED`, a same-day
  // confirm, a server error) is never dismissed by a photo finishing in the
  // background.
  useEffect(() => {
    if (photo.phase !== "ready") return;
    const photoRefusalMessage =
      kind === "tattoo"
        ? inputCodeMessage("TATTOO_PHOTO_REQUIRED")
        : kind === "post_adoption_checkin"
          ? inputCodeMessage("CHECKIN_PHOTO_INVALID")
          : null;
    if (photoRefusalMessage === null) return;
    setError((current) => (current === photoRefusalMessage ? null : current));
  }, [photo.phase, kind]);
  /** T4-M1 (2026-09-22): guards the recovery effect below against StrictMode's
   *  mount → unmount → mount. See that effect's own comment. */
  const startedRecovery = useRef(false);
  /**
   * T4-M1 (2026-09-22): whether ANY photo attempt — live or recovered — has
   * already begun. A PLAIN REF AND NOT `photo.phase` READ FROM A `setState`
   * UPDATER, and that is not a style choice: an earlier draft of the recovery
   * effect below set a local `claimed` flag INSIDE a `setPhoto` updater and
   * read it on the very next line, on the assumption that React runs the
   * updater synchronously. Measured here that it does not — under this test
   * renderer's `act()` batching, `setPhoto(fn)` can return with the updater
   * still unrun, so the immediate read saw `claimed === false` and the
   * recovered photo silently never uploaded. A ref has no such assumption to
   * get wrong: it is a plain mutable value, read and written synchronously,
   * independent of whatever React's scheduler decides to do with the render
   * it's connected to.
   */
  const photoAttemptStarted = useRef(false);
  // D7: LOS DOS KINDS QUE TIENEN FOTO, Y NADA MAS. `pickImageSafely`'s marker
  // necesita saber CUAL de los dos pantallas esta pidiendo — antes solo existia
  // "tattoo" — y este valor es lo unico que las funciones de abajo consultan
  // para no repetir el chequeo `kind === "tattoo" || kind === "post_adoption_checkin"`
  // en cada una. `null` en cualquier otro kind: esas funciones nunca corren
  // ahi, porque el boton que las dispara solo se dibuja para estos dos.
  const photoScreen: "tattoo" | "post_adoption_checkin" | null =
    kind === "tattoo" || kind === "post_adoption_checkin" ? kind : null;

  // ELEGIR Y SUBIR SON UN SOLO GESTO PARA UNA ELECCION EN VIVO, y suben AHORA
  // y no al enviar. La persona se entera de que la subida fallo mientras
  // todavia esta mirando la foto, no despues de completar cuatro campos mas;
  // y un campo mal cargado no cuesta megabytes. El objeto en staging dura dos
  // horas, mas de lo que tarda cualquiera en terminar este formulario. Ver
  // `tattoo-photo-flow.ts`.
  //
  // "EN VIVO" ES LA PALABRA QUE IMPORTA (T3-R4, 2026-09-22): esta funcion es
  // la unica que auto-sube. La recuperacion de abajo NUNCA la llama — ver
  // `applyRecoveredTattooPhoto` — precisamente porque una foto recuperada no
  // tiene ningun toque detras que justifique subirla sola.
  async function pickTattooPhoto() {
    // GUARDA DEFENSIVA: este boton solo se dibuja cuando `photoScreen` no es
    // null (ver el JSX mas abajo), asi que esto nunca deberia disparar.
    if (photoScreen === null) return;
    // SINCRONICO, ANTES DE CUALQUIER `await`: esto es lo que la recuperacion
    // de abajo revisa para saber si una eleccion en vivo ya la gano.
    photoAttemptStarted.current = true;
    setPhoto({ phase: "picking" });
    // LA MARCA (T3-R4, 2026-09-22): se escribe en disco ANTES de que se abra
    // el selector nativo, para que una recuperacion despues de una muerte de
    // proceso pueda comprobarse contra ESTA mascota y ESTA sesion antes de
    // mostrarse. Ver `image-picker-port.ts`.
    const sessionUserId = currentSessionUserId();
    const result = await pickImageSafely(
      sessionUserId === null ? null : { screen: photoScreen, publicToken, sessionUserId },
      ASYNC_IMAGE_PICK_MARKER_STORE,
    );
    // `pickImageSafely` y no `getImagePickerPort().pickImage()`: este await es
    // pelado, y un puerto que tirara una excepcion dejaria el formulario en
    // `picking` para siempre — sin frase y sin salida que no sea el boton fisico
    // de atras. La misma razon que en `PetPhotoScreen`.
    await applyPickedTattooPhoto(result);
  }

  /**
   * Sube lo que ya fue ACEPTADO — por una eleccion en vivo, o por el toque de
   * confirmacion en la fase `review` de abajo. Separada de `pickTattooPhoto`
   * para que el mismo camino de subida sirva a las dos entradas sin volver a
   * llamar al modulo nativo.
   */
  const stagePickedTattooPhoto = useCallback(
    async (image: AcceptedImage) => {
      setPhoto({ phase: "uploading", image });
      const staged = await stageTattooPhoto(sessionPort, publicToken, image);
      if (staged.outcome === "failed") {
        setPhoto({ phase: "failed", message: petPhotoFailureMessage(staged.failure) });
        return;
      }
      setPhoto({
        phase: "ready",
        previewUri: image.previewUri,
        stagedPath: staged.stagedPath,
      });
    },
    [publicToken],
  );

  /**
   * Todo lo que pasa DESPUES de una eleccion EN VIVO. Acepta el resultado y,
   * si es una foto, la sube de una — el gesto de haberla elegido recien es la
   * confirmacion. `message: null` es cancelar: volver al principio sin nada
   * que decir.
   */
  const applyPickedTattooPhoto = useCallback(
    async (result: ImagePickResult) => {
      const picked = acceptPickedImage(result);
      if (!picked.ok) {
        setPhoto(
          picked.message === null
            ? { phase: "none" }
            : { phase: "failed", message: picked.message },
        );
        return;
      }
      await stagePickedTattooPhoto(picked.image);
    },
    [stagePickedTattooPhoto],
  );

  /**
   * Todo lo que pasa con una foto RECUPERADA (T4-M1 la trajo, T3-R4 la ato).
   *
   * NUNCA SUBE SOLA, Y ESA ES LA DIFERENCIA ENTERA CON `applyPickedTattooPhoto`.
   * Una foto que Android sostuvo desde antes de este montaje no tiene ningun
   * gesto detras — la persona no tenia ni siquiera este formulario abierto
   * cuando el proceso murio — asi que auto-subirla seria mandar bytes de la
   * mascota A al tatuaje de la mascota B (o de otra sesion, en un telefono
   * compartido) sin que nadie haya mirado la foto ni tocado nada. Aterriza en
   * `review`, que exige el toque de `TattooPhotoField` antes de que
   * `stagePickedTattooPhoto` corra.
   */
  const applyRecoveredTattooPhoto = useCallback((result: ImagePickResult) => {
    const picked = acceptPickedImage(result);
    if (!picked.ok) {
      setPhoto(
        picked.message === null ? { phase: "none" } : { phase: "failed", message: picked.message },
      );
      return;
    }
    setPhoto({ phase: "review", image: picked.image });
  }, []);

  // T4-M1 (2026-09-22): LA MISMA RECUPERACION QUE `PetPhotoScreen`, para la
  // otra pantalla que puede haber dejado a Android sosteniendo una foto. Solo
  // aplica si NINGUN intento — en vivo o recuperado — empezo todavia
  // (`photoAttemptStarted`): si la persona ya volvio a tocar el boton, esa
  // eleccion en vivo no debe perder contra una que Android recupero de antes.
  //
  // `startedRecovery` Y NO SOLO `cancelled`, por la misma razon que
  // `launch-update-gate.ts` la tiene: StrictMode monta → desmonta → vuelve a
  // montar para probar que los efectos son puros, y un puerto de prueba (a
  // diferencia del adaptador real) no es claim-once por si solo — sin este
  // ref, la segunda pasada pedia la misma foto recuperada otra vez y la
  // subia dos veces.
  //
  // ATADA A ESTA MASCOTA Y ESTA SESION (T3-R4, 2026-09-22). Un desajuste de
  // marca — otra mascota, otra persona firmada, otra pantalla, o una marca
  // simplemente vieja — es `recoverPendingPickSafely` contestando `null`, que
  // este efecto ya trata igual que "nada que recuperar". Sin sesion no hay
  // con que atar la marca, asi que el llamado se salta en vez de adivinar.
  useEffect(() => {
    if (photoScreen === null || startedRecovery.current) return;
    startedRecovery.current = true;
    let cancelled = false;
    void (async () => {
      const sessionUserId = currentSessionUserId();
      if (sessionUserId === null) return;
      const recovered = await recoverPendingPickSafely(
        { screen: photoScreen, publicToken, sessionUserId },
        ASYNC_IMAGE_PICK_MARKER_STORE,
      );
      if (cancelled || recovered === null) return;
      // SINCRONICO, LOS DOS JUNTOS: leer y marcar `photoAttemptStarted` sin
      // ningun `await` entre medio es lo que hace que esta carrera contra
      // `pickTattooPhoto` no dependa de cuando React decida correr nada.
      if (photoAttemptStarted.current) return;
      photoAttemptStarted.current = true;
      applyRecoveredTattooPhoto(recovered);
    })();
    return () => {
      cancelled = true;
    };
  }, [photoScreen, publicToken, applyRecoveredTattooPhoto]);

  function set<K extends keyof EventDraft>(field: K, value: EventDraft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
    setInvalid((current) => {
      if (!current.has(field)) return current;
      const next = new Set(current);
      next.delete(field);
      return next;
    });
  }

  async function submit(sameDayOverride: boolean) {
    const validated = validateDraft(kind, draft, {
      sourceEventId,
      sameDayOverride,
      // NULL HASTA QUE LA FOTO ESTE ARRIBA. En tattoo el contrato lo refuta
      // con `TATTOO_PHOTO_REQUIRED`; en check-in (D7) `null` es una respuesta
      // valida — la foto es opcional ahi. Ninguno de los dos campos lo escribe
      // la persona: lo produce la subida.
      stagedPath: photo.phase === "ready" ? photo.stagedPath : null,
    });
    if (!validated.ok) {
      setError(validated.message);
      setInvalid(invalidFields(validated.code));
      setState({ phase: "editing" });
      return;
    }
    setError(null);
    setInvalid(new Set());
    setState({ phase: "sending" });
    const result = await recordPetEvent(
      sessionPort,
      publicToken,
      validated.input,
      attempt.current.key(),
    );
    if (result.outcome === "ok") {
      // THE ONLY PLACE THE DRAFT IS DESTROYED BY THIS SCREEN, and it is inside
      // the arm where the SERVER said yes. A draft that outlives its own
      // successful submit comes back on the next open and reads as "the app did
      // not save my record" — the exact fear the draft exists to remove,
      // delivered by the thing that was supposed to remove it.
      //
      // `wasDuplicate` IS A SUCCESS AND CLEARS TOO: the server answering "this
      // key already appended" means the asiento is on the spine. Every other
      // arm below keeps the draft, because on every one of them nothing was
      // written and the person still needs what they typed.
      forgetOnSuccess();
      setState({ phase: "done", wasDuplicate: result.payload.wasDuplicate });
      return;
    }
    // The soft gate is a QUESTION, not a refusal: the same body goes back with
    // the override, on the SAME key, because nothing was written. So the draft
    // stays: this arm is one tap away from a submit, and a person who answers
    // "no" is back on a form that must still hold their text.
    if (result.outcome === "api-error" && result.code === "same_day_duplicate_suspected") {
      setState({ phase: "confirming-same-day" });
      return;
    }
    setError(apiFailureMessage(result) ?? "No pudimos guardar el registro.");
    setState({ phase: "editing" });
  }

  // ESTA BUILD NO PUEDE ELEGIR UNA FOTO, y el tatuaje es el unico asiento que
  // EXIGE una. La regla es la del puerto y la que `PetPhotoScreen` ya sigue:
  // leer `available` ANTES de dibujar un control, para que nadie busque un
  // boton que no puede funcionar. Se lee en cada render — un test cambia el
  // puerto por caso; la app lo cambia una sola vez, al arrancar.
  if (kind === "tattoo" && !getImagePickerPort().available) {
    return (
      <Screen>
        <View style={styles.header}>
          <Eyebrow>Anotar</Eyebrow>
          <Title>{kindTitle(kind)}</Title>
        </View>
        <Callout tone="neutral" title="Todavía no se puede registrar un tatuaje desde la app">
          <Body>
            El tatuaje necesita una foto, y en esta versión la foto se carga desde la web: entrá a
            Mis mascotas, abrí la mascota y elegí Tatuaje. La credencial lo va a mostrar acá apenas
            lo cargues.
          </Body>
        </Callout>
        {onBack === null ? null : <SecondaryButton label="Elegir otro tipo" onPress={onBack} />}
      </Screen>
    );
  }

  if (state.phase === "done") {
    return (
      <Screen>
        <Callout tone="ok" title={state.wasDuplicate ? "Ya estaba registrado" : "Listo"}>
          <Body>{state.wasDuplicate ? RECORD_DUPLICATE_LABEL : RECORD_DONE_LABEL}</Body>
        </Callout>
        {/* BACK TO THE FACE THIS WROTE INTO, which is what the label has always
            promised (native QA batch 1, D3). `credentialRoute` with no options
            opens the document on the credential, so the person who had just
            written an asiento landed on the FRONT of the card and had to find
            the turn button to see what they had done. The asiento is on the
            back; so is the return. */}
        {/* `allowLeave()` FIRST, and it is not decoration: the guard fires on
            every navigation away, including the one this screen makes itself
            after the asiento has landed. Two screens shipped without it in the
            batch before this one (finding H1) and asked "¿Salir sin guardar?"
            about a write that was already on the server. `app/alta.tsx` is the
            precedent. `dirty` is false here anyway — `state.phase` is `done` —
            and the call stays because a future edit to that condition must not
            be able to trap somebody on an acknowledgement. */}
        <PrimaryButton
          label="Volver a la libreta"
          onPress={() => {
            allowLeave();
            router.replace(credentialRoute(publicToken, { face: "libreta" }));
          }}
        />
      </Screen>
    );
  }

  const busy = state.phase === "sending";
  const cta = recordEventCta(kind);
  /**
   * Los dos llegaron al mismo formulario: una captura recién leída y un
   * borrador guardado. Ver el callout de abajo para qué se hace con eso.
   *
   * SE MIRAN LAS CLAVES Y NO LOS VALORES porque `prefill` sólo lleva los campos
   * que la frase llenó de verdad: una captura que no entendió ningún dato (una
   * mordedura, por ejemplo) llega vacía y no tiene nada que pisar ni que
   * anunciar.
   */
  const capturedOver = restored !== null && Object.keys(prefill).length > 0;

  return (
    <Screen keyboardAvoiding scrollRef={scrollRef}>
      <View style={styles.header}>
        <Eyebrow>Anotar</Eyebrow>
        <Title>{kindTitle(kind)}</Title>
        <Body>{kindSubtitle(kind)}</Body>
      </View>

      {/* ABOVE THE FIELDS AND NOT BELOW THEM, because it is about the fields:
          the person has to meet the sentence before they meet the text it
          explains, not after they have scrolled past somebody else's words
          wondering where they came from. `tone="neutral"` and not `ok` — a
          recovered draft is not good news about a registration, it is a
          statement of fact about a form. See `RESTORED_DRAFT_TITLE`. */}
      {restored === null ? null : (
        <Callout tone="neutral" title={RESTORED_DRAFT_TITLE}>
          <Body>{restoredDraftNote(restored.savedAt)}</Body>
          {/* CUANDO LOS DOS QUIEREN EL MISMO FORMULARIO, GANA EL BORRADOR.
              Alguien escribió "pesó 12 kilos", la app leyó Peso, y adentro ya
              había un pesaje a medio escribir de hace tres días. Son dos cosas
              distintas y las dos son de la persona; hay que elegir, y se elige
              así:

                · EL BORRADOR GANA EL FORMULARIO. Es lo único de los dos que
                  alguien TIPEÓ. Pisarlo sería esta función destruyendo texto,
                  que es exactamente lo que el borrador existe para impedir.
                · PERO NO EN SILENCIO. La otra mitad del error es peor: si la
                  captura desapareciera sin decirlo, la persona vería el
                  formulario abierto con un peso VIEJO en el campo, creería que
                  son los 12 kilos que acaba de escribir, y firmaría. Esto es una
                  libreta que no se edita.
                · Y DESCARTAR EL BORRADOR DEJA LA CAPTURA, sin una línea de
                  código extra: `discardRestored` devuelve el formulario al valor
                  con el que esta pantalla arrancó, y ese valor ES el prefill
                  (ver el `useState` de arriba). La frase de abajo se limita a
                  decir en voz alta algo que ya era cierto. */}
          {capturedOver ? (
            <Body>
              Lo que acabás de contar no se aplicó, para no pisar el borrador. Si descartás el
              borrador, quedan esos datos.
            </Body>
          ) : null}
          <SecondaryButton
            label="Descartar el borrador"
            disabled={busy}
            onPress={() =>
              confirmDiscard(
                capturedOver ? DISCARD_COPY.draftOverCapture : DISCARD_COPY.draft,
                discardRestored,
              )
            }
          />
        </Callout>
      )}

      <Fields
        kind={kind}
        draft={draft}
        set={set}
        invalid={invalid}
        pppRegistries={pppRegistries}
        species={species}
        petPlace={petPlace}
      />

      {/* D7: THE BUTTON, NOT THE WHOLE FORM, DISAPPEARS WITHOUT THE PORT.
          Tattoo blocks the whole screen a few lines above because it has
          nothing to send without a photo; the check-in DOES have something to
          send — the text — so when the port is unavailable this section is
          simply not drawn, with no callout: the check-in can still be sent,
          with or without a photo, on any build. */}
      {photoScreen !== null && getImagePickerPort().available ? (
        <TattooPhotoField
          kind={photoScreen}
          state={photo}
          busy={busy}
          petName={petName}
          onPick={() => void pickTattooPhoto()}
          onConfirmRecovered={(image) => void stagePickedTattooPhoto(image)}
          onDiscardRecovered={() => setPhoto({ phase: "none" })}
        />
      ) : null}

      <Card>
        <Body>{RECORD_IMMUTABILITY_NOTE}</Body>
      </Card>

      {error === null ? null : (
        // The anchor useScrollToError drives: on a form this long the refusal
        // can appear under the keyboard or below the fold. See the hook.
        <View ref={errorAnchor}>
          <Callout tone="err" title="No se pudo guardar">
            <Body>{error}</Body>
          </Callout>
        </View>
      )}

      {state.phase === "confirming-same-day" ? (
        <Callout tone="warn" title="¿Registrar otro?">
          <Body>{SAME_DAY_PROMPT_LABEL}</Body>
          <PrimaryButton label="Sí, registrar igual" onPress={() => void submit(true)} />
        </Callout>
      ) : null}

      {/* NAMES WHAT IT WRITES (A2-alta-asentar-R05). See `recordEventCta`. */}
      <PrimaryButton
        label={busy ? cta.busyLabel : cta.label}
        disabled={busy}
        onPress={() => void submit(false)}
      />
      {/* "ELEGIR OTRO TIPO" IS A DISCARD THE NAVIGATOR CANNOT SEE
          (A2-alta-asentar-08). The screen stays and the FORM is remounted under
          a new `key` — deliberately, so the new asiento gets its own idempotency
          key — which takes every field with it. `beforeRemove` never fires, so
          the confirm has to be asked here, in the same words.
          AND IT IS NOT A DISCARD ANY MORE, which is why the words changed with
          it: the unmount the remount causes is a departure like any other, so
          the abandoned form's draft is written under ITS OWN kind's key and is
          waiting there if the person comes back to it. */}
      {onBack === null ? null : (
        <SecondaryButton
          label="Elegir otro tipo"
          onPress={() => (dirty ? confirmDiscard(DISCARD_COPY.asiento, onBack) : onBack())}
          disabled={busy}
        />
      )}
    </Screen>
  );
}

/**
 * LA FOTO, dibujada — del tatuaje, o (D7) del check-in post-adopción.
 *
 * VIVE FUERA DE `Fields` porque `Fields` renderiza el BORRADOR y nada mas: le
 * llegan `draft` y `set`, y la foto no esta en ninguno de los dos. Meterla ahi
 * obligaria a pasarle tres props que diecisiete de los diecinueve kinds
 * ignoran.
 *
 * NO HAY ESTADO `unavailable` EN ESTA UNION. Cuando el puerto no puede elegir
 * una imagen, tattoo no dibuja el formulario entero — `EventForm` contesta
 * antes con el callout que nombra la web — y check-in simplemente no dibuja
 * ESTA seccion, porque su foto es opcional y el resto del formulario sigue
 * andando. Ningun estado mas aca decide lo mismo dos veces.
 *
 * `kind` ES LA UNICA DIFERENCIA DE COPIA entre los dos usos: tattoo dice que
 * la foto es obligatoria porque lo es (el contrato la refuta si falta);
 * check-in dice que es opcional porque lo es. Todo el resto del componente —
 * los cinco estados, la recuperacion, la subida — es exactamente el mismo
 * camino para los dos.
 */
function TattooPhotoField({
  kind,
  state,
  busy,
  petName,
  onPick,
  onConfirmRecovered,
  onDiscardRecovered,
}: {
  kind: "tattoo" | "post_adoption_checkin";
  state: TattooPhotoState;
  /** El asiento se esta mandando: nada de cambiar la foto en el medio. */
  busy: boolean;
  /** El nombre de esta mascota, para la confirmacion de una foto recuperada
   *  (T3-R4, 2026-09-22). `null` mientras el read no contesto o si vino
   *  degradado — la fase `review` cae a una frase sin nombre. */
  petName: string | null;
  onPick: () => void;
  /** El toque que sube una foto RECUPERADA — nunca se llama sola. */
  onConfirmRecovered: (image: AcceptedImage) => void;
  /** Descarta la foto recuperada sin subir nada. */
  onDiscardRecovered: () => void;
}) {
  const isTattoo = kind === "tattoo";
  const working = state.phase === "picking" || state.phase === "uploading";
  const previewAccessibilityLabel = isTattoo
    ? "Vista previa de la foto del tatuaje"
    : "Vista previa de la foto del check-in";
  const label = (() => {
    switch (state.phase) {
      case "picking":
        return "Abriendo tus fotos…";
      case "uploading":
        // NOMBRA LA SUBIDA, que es la parte que tarda en un plan de datos flojo.
        return "Subiendo la foto…";
      case "review":
      case "ready":
        return "Elegir otra foto";
      default:
        return isTattoo ? "Elegir la foto del tatuaje" : "Agregar una foto (opcional)";
    }
  })();

  return (
    <Card>
      {/* POR QUE SE PIDE (o se ofrece), y no solo que se pide. Tattoo repite la
          misma frase con la que la web refuta un formulario sin archivo;
          check-in dice lo contrario a proposito, porque ahi SÍ es opcional —
          el contrato la acepta ausente y el mensaje no puede sugerir lo
          contrario. */}
      <Body>
        {isTattoo
          ? "La foto es obligatoria: es la mejor forma de que quien encuentre a tu mascota reconozca el tatuaje."
          : "Podés agregar una foto si querés — al refugio le sirve para ver cómo está. No hace falta para enviar el check-in."}
      </Body>
      {/* PO decision 20A (native review), same line `PetPhotoScreen` carries:
          this button opens the gallery (`launchImageLibraryAsync`) and has no
          camera control of its own. */}
      {state.phase === "none" || state.phase === "failed" ? (
        <Body>
          Podés elegir una que ya tengas, o sacar una nueva con la cámara y elegirla después.
        </Body>
      ) : null}

      {state.phase === "ready" && state.previewUri !== null ? (
        <Image
          source={{ uri: state.previewUri }}
          style={styles.tattooPreview}
          resizeMode="cover"
          accessibilityRole="image"
          accessibilityLabel={previewAccessibilityLabel}
        />
      ) : null}

      {state.phase === "ready" ? (
        <Callout tone="ok" title="Foto lista">
          {/* DICE QUE TODAVIA NO SE GUARDO NADA. Los bytes estan arriba pero el
              asiento no existe hasta que se aprieta el boton de abajo, y una
              pantalla que dijera "listo" acá estaría mintiendo. */}
          <Body>Se va a guardar junto con el asiento cuando lo registres.</Body>
        </Callout>
      ) : null}

      {/* T3-R4 (2026-09-22): UNA FOTO RECUPERADA, EN ESPERA DE UN TOQUE. Llego
          sin ningun gesto detras — el proceso murio con el selector nativo
          abierto y nadie esta mirando este formulario todavia — asi que
          aterriza aca en vez de subir sola, con el nombre de la mascota en la
          pantalla, la misma idea que la fase de revision de `PetPhotoScreen`. */}
      {state.phase === "review" ? (
        <>
          {state.image.previewUri !== null ? (
            <Image
              source={{ uri: state.image.previewUri }}
              style={styles.tattooPreview}
              resizeMode="cover"
              accessibilityRole="image"
              accessibilityLabel={previewAccessibilityLabel}
            />
          ) : null}
          <Callout
            tone="neutral"
            title={isTattoo ? "¿Es esta la foto del tatuaje?" : "¿Es esta la foto?"}
          >
            <Body>
              {isTattoo
                ? petName === null
                  ? "Recuperamos una foto que habías elegido antes de que la app se cerrara. Confirmá que es la del tatuaje antes de subirla."
                  : `Recuperamos una foto que habías elegido antes de que la app se cerrara. Confirmá que es la del tatuaje de ${petName} antes de subirla.`
                : petName === null
                  ? "Recuperamos una foto que habías elegido antes de que la app se cerrara. Confirmá que es la que querés mandar antes de subirla."
                  : `Recuperamos una foto que habías elegido antes de que la app se cerrara. Confirmá que es la que querés mandar con el check-in de ${petName} antes de subirla.`}
            </Body>
          </Callout>
          <PrimaryButton label="Usar esta foto" onPress={() => onConfirmRecovered(state.image)} />
          <SecondaryButton label="Descartar" onPress={onDiscardRecovered} />
        </>
      ) : null}

      {state.phase === "failed" ? (
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
      ) : null}

      <SecondaryButton label={label} disabled={working || busy} onPress={onPick} />
    </Card>
  );
}

/**
 * How many SINGLE-LINE fields a kind's form has, in the order they are drawn —
 * the length of its return-key chain (forms-F6). Multiline fields and choice
 * rows are not in the chain: a multiline return types a newline, and a chip
 * row has no keyboard. The custom-interval field appears only for a custom
 * frequency, which is why this reads the draft.
 *
 * Kept beside the fields it counts, because a count and a form that drift
 * apart give the wrong field the "done" key — and a `switch` with no default
 * is what makes a new kind a compile error here rather than a wrong count.
 */
function chainLength(kind: WritableKind, draft: EventDraft): number {
  switch (kind) {
    case "vaccination":
      return 6;
    case "weight":
      return 2;
    case "deworming":
      return 3;
    case "medication_start":
      return draft.frequency === "custom" ? 8 : 7;
    case "medication_end":
      return 2;
    case "vet_visit":
      return 4;
    case "clinical_info":
      return 3;
    case "sterilization":
      return 3;
    case "microchip":
      return 5;
    case "note":
      return 1;
    case "symptom":
      return 1;
    // Motivo is a chip row, so it is not in the chain: número nuevo, quién lo
    // hizo, fecha.
    case "microchip_replace":
      return 3;
    // Registro is a chip row for the same reason: id, fecha.
    case "dangerous_breed_attestation":
      return 2;
    // TRES FIJOS —detalle de la causa, fecha, establecimiento— más los dos que
    // aparecen sólo si la persona los abre. Las respuestas de tipo chip (causa,
    // enfermedad, laboratorio, clínica, contacto, decisión, destino) no están en
    // la cadena porque no se tipean.
    case "death":
      return 3 + (draft.deathAtClinic === "si" ? 1 : 0) + (draft.confirmedByVet === "si" ? 1 : 0);
    // Donde, contexto, fecha, y los tres de la victima. El selector de localidad
    // tiene su propio buscador y no entra en la cadena; las dos filas de chips
    // tampoco se tipean.
    case "bite":
      return 6;
    // Codigo, fecha, descripcion y quien lo hizo. La fila de chips del lugar no
    // se tipea y el boton de la foto tampoco.
    case "tattoo":
      return 4;
    // Semanas, fecha, veterinario. Tres campos tipeados.
    case "pregnancy_start":
      return 3;
    // Fecha, veterinario, y las crías sólo cuando nacieron con vida. El
    // desenlace es una fila de chips y no se tipea.
    case "pregnancy_end":
      return 2 + (draft.outcome === "live_birth" ? 1 : 0);
    // Un solo campo: cómo está.
    case "post_adoption_checkin":
      return 1;
  }
}

/** The fields for one kind. Every date is `DD/MM/AAAA`; see `DateField`. */
function Fields({
  kind,
  draft,
  set,
  invalid,
  pppRegistries = [],
  species = null,
  petPlace = null,
}: {
  kind: WritableKind;
  draft: EventDraft;
  set: <K extends keyof EventDraft>(field: K, value: EventDraft[K]) => void;
  /** The fields the last refusal named — they draw the red border. */
  invalid: ReadonlySet<keyof EventDraft>;
  /**
   * The registries this animal's JURISDICTION names for a PPP attestation,
   * resolved server-side from `ppp_attestation_required_registries`.
   *
   * DEFAULTS TO NONE, and the empty case is a real one rather than a
   * placeholder: a jurisdiction under the regime with no registry loaded is
   * exactly what the web's form handles by letting the person write the
   * registry themselves. Same two shapes here.
   */
  pppRegistries?: readonly OwnerPetPppRegistryV1[];
  /** The animal's species, for the death form's disease picker. `null` = unknown. */
  species?: string | null;
  /** "Localidad, Provincia" of the animal — where the bite map opens (M17). */
  petPlace?: string | null;
}) {
  // The return key walks the single-line fields in draw order. `link()` hands
  // out the next slot each time it is called, and it is called in JSX order.
  const chain = useReturnKeyChain(chainLength(kind, draft));
  let slot = 0;
  const link = () => chain(slot++);

  // The kit's `DateField`: the native calendar on Android, the `DD/MM/AAAA`
  // mask as its typed fallback (M18). Pre-filled with today in ARGENTINE time;
  // the view-model converts to the wire's `AAAA-MM-DD` before the contract
  // judges it — which still refuses a day that does not exist rather than
  // rolling it over.
  //
  // THE CALENDAR STOPS AT TODAY for `occurredAt` and `onsetAt`, because the
  // server already refuses a future day for both (`event_date_future`, and the
  // onset rule in record-event.ts: "not in the future"). `nextDueAt` is a
  // future day by nature and gets no bound.
  const today = isoDayToLocalDate(todayInAr()) ?? undefined;
  const dateField = (
    label: string,
    field: "occurredAt" | "nextDueAt" | "onsetAt",
    required: boolean,
  ) => (
    <DateField
      label={label}
      required={required}
      value={draft[field]}
      invalid={invalid.has(field)}
      onChangeText={(value) => set(field, value)}
      maximumDate={field === "nextDueAt" ? undefined : today}
      {...link()}
    />
  );

  switch (kind) {
    case "vaccination":
      return (
        <>
          <TextField
            label="Vacuna"
            required
            value={draft.vaccineName}
            invalid={invalid.has("vaccineName")}
            onChangeText={(v) => set("vaccineName", v)}
            placeholder="Antirrábica"
            {...link()}
          />
          {dateField("Fecha de aplicación", "occurredAt", true)}
          <TextField
            label="Marca"
            value={draft.brand}
            onChangeText={(v) => set("brand", v)}
            {...link()}
          />
          <TextField
            label="Lote"
            mono
            value={draft.batch}
            onChangeText={(v) => set("batch", v)}
            {...link()}
          />
          <TextField
            label="Aplicada por"
            value={draft.administeredBy}
            onChangeText={(v) => set("administeredBy", v)}
            {...link()}
          />
          {dateField("Próxima dosis", "nextDueAt", false)}
          <NotesField draft={draft} set={set} />
        </>
      );

    case "weight":
      return (
        <>
          <TextField
            label="Peso (kg)"
            required
            mono
            value={draft.kg}
            invalid={invalid.has("kg")}
            onChangeText={(v) => set("kg", v)}
            placeholder="12,5"
            inputMode="decimal"
            {...link()}
          />
          {dateField("Fecha", "occurredAt", true)}
          <NotesField draft={draft} set={set} />
        </>
      );

    case "deworming":
      return (
        <>
          <TextField
            label="Producto"
            required
            value={draft.product}
            invalid={invalid.has("product")}
            onChangeText={(v) => set("product", v)}
            {...link()}
          />
          <Choice
            label="Tipo"
            required
            options={DEWORMING_TYPE_OPTIONS}
            selected={draft.dewormingType}
            optionLabel={dewormingTypeLabel}
            onSelect={(value) => set("dewormingType", value)}
          />
          {dateField("Fecha de aplicación", "occurredAt", true)}
          {dateField("Próxima dosis", "nextDueAt", false)}
          <NotesField draft={draft} set={set} />
        </>
      );

    case "medication_start":
      return (
        <>
          <TextField
            label="Medicamento"
            required
            value={draft.drugName}
            invalid={invalid.has("drugName")}
            onChangeText={(v) => set("drugName", v)}
            {...link()}
          />
          <TextField
            label="Dosis"
            required
            value={draft.dose}
            invalid={invalid.has("dose")}
            onChangeText={(v) => set("dose", v)}
            placeholder="250 mg"
            {...link()}
          />
          <TextField
            label="Recetada por"
            value={draft.prescribedBy}
            onChangeText={(v) => set("prescribedBy", v)}
            {...link()}
          />
          {dateField("Fecha de inicio", "occurredAt", true)}
          <Choice
            label="Frecuencia"
            required
            options={FREQUENCY_OPTIONS}
            selected={draft.frequency}
            optionLabel={frequencyLabel}
            onSelect={(value) => set("frequency", value)}
          />
          {draft.frequency === "custom" ? (
            <TextField
              label="Cada cuántas horas"
              required
              mono
              value={draft.customHours}
              invalid={invalid.has("customHours")}
              onChangeText={(v) => set("customHours", v)}
              placeholder="8"
              inputMode="numeric"
              {...link()}
            />
          ) : null}
          <TextField
            label="Duración (días)"
            mono
            value={draft.durationDays}
            invalid={invalid.has("durationDays")}
            onChangeText={(v) => set("durationDays", v)}
            placeholder="7"
            inputMode="numeric"
            {...link()}
          />
          {/* TWO FIELDS FOR ONE VALUE, joined by the view-model. A single
              "AAAA-MM-DDTHH:mm" box would ask a person to type a `T`. */}
          <DateField
            label="Primera dosis — día"
            required
            value={draft.firstDoseDay}
            invalid={invalid.has("firstDoseDay")}
            onChangeText={(v) => set("firstDoseDay", v)}
            {...link()}
          />
          <TimeField
            label="Primera dosis — hora"
            required
            value={draft.firstDoseTime}
            invalid={invalid.has("firstDoseTime")}
            onChangeText={(v) => set("firstDoseTime", v)}
            {...link()}
          />
          <NotesField draft={draft} set={set} />
        </>
      );

    case "medication_end":
      return (
        <>
          {dateField("Fecha de fin", "occurredAt", true)}
          <TextField
            label="Motivo"
            value={draft.reason}
            onChangeText={(v) => set("reason", v)}
            placeholder="Tratamiento completo"
            {...link()}
          />
          <NotesField draft={draft} set={set} />
        </>
      );

    case "vet_visit":
      return (
        <>
          <TextField
            label="Motivo de la visita"
            required
            value={draft.visitReason}
            invalid={invalid.has("visitReason")}
            onChangeText={(v) => set("visitReason", v)}
            placeholder="Control anual"
            {...link()}
          />
          {dateField("Fecha", "occurredAt", true)}
          {/* FREE TEXT, and deliberately not a disease picker. A diagnosis
              chosen from the catalog is a signed professional claim with an
              outbreak-signal cascade behind it; this is the owner writing down
              what the vet told them. */}
          <TextField
            label="Diagnóstico"
            multiline
            value={draft.diagnosis}
            onChangeText={(v) => set("diagnosis", v)}
            placeholder="Lo que te dijo el veterinario"
          />
          <TextField
            label="Veterinario/a"
            value={draft.vetName}
            onChangeText={(v) => set("vetName", v)}
            {...link()}
          />
          <TextField
            label="Clínica"
            value={draft.clinic}
            onChangeText={(v) => set("clinic", v)}
            {...link()}
          />
          <NotesField draft={draft} set={set} />
        </>
      );

    case "clinical_info":
      return (
        <>
          <Choice
            label="Tipo"
            required
            options={CLINICAL_SUB_KIND_OPTIONS}
            selected={draft.clinicalSubKind}
            optionLabel={clinicalSubKindLabel}
            onSelect={(value) => set("clinicalSubKind", value)}
          />
          <TextField
            label="Estudio o procedimiento"
            required
            value={draft.title}
            invalid={invalid.has("title")}
            onChangeText={(v) => set("title", v)}
            placeholder="Hemograma completo"
            {...link()}
          />
          {dateField("Fecha", "occurredAt", true)}
          <TextField
            label="Detalle"
            multiline
            value={draft.details}
            onChangeText={(v) => set("details", v)}
            placeholder="Resultados, valores, observaciones"
          />
          <TextField
            label="Realizado por"
            value={draft.performedBy}
            onChangeText={(v) => set("performedBy", v)}
            {...link()}
          />
          <NotesField draft={draft} set={set} />
        </>
      );

    case "sterilization":
      return (
        <>
          <Choice
            label="Procedimiento"
            required
            options={STERILIZATION_PROCEDURE_OPTIONS}
            selected={draft.procedure}
            optionLabel={sterilizationProcedureLabel}
            onSelect={(value) => set("procedure", value)}
          />
          {dateField("Fecha de la cirugía", "occurredAt", true)}
          <TextField
            label="Realizada por"
            value={draft.performedBy}
            onChangeText={(v) => set("performedBy", v)}
            {...link()}
          />
          <TextField
            label="Clínica"
            value={draft.clinic}
            onChangeText={(v) => set("clinic", v)}
            {...link()}
          />
          <NotesField draft={draft} set={set} />
        </>
      );

    case "microchip":
      return (
        <>
          {/* MONO AND numeric-ish, because this is a code that gets read back
              off a scanner and compared digit by digit. No length rule: the
              server checks it against the pet's CANONICAL chip, and a 15-digit
              mask invented here would refuse the shorter legacy codes the web
              accepts. */}
          <TextField
            label="Número de microchip"
            required
            mono
            value={draft.chipNumber}
            invalid={invalid.has("chipNumber")}
            onChangeText={(v) => set("chipNumber", v)}
            placeholder="982000123456789"
            autoCapitalize="none"
            autoCorrect={false}
            // `inputMode`, not `keyboardType="numbers-and-punctuation"`: that
            // keyboard type is iOS-only and Android opened QWERTY (forms-F1).
            inputMode="numeric"
            {...link()}
          />
          {dateField("Fecha de implantación", "occurredAt", true)}
          <TextField
            label="País"
            value={draft.countryCode}
            onChangeText={(v) => set("countryCode", v)}
            placeholder="AR"
            autoCapitalize="characters"
            autoCorrect={false}
            {...link()}
          />
          <TextField
            label="Implantado por"
            value={draft.implantedBy}
            onChangeText={(v) => set("implantedBy", v)}
            {...link()}
          />
          <TextField
            label="Zona del cuerpo"
            value={draft.locationOnBody}
            onChangeText={(v) => set("locationOnBody", v)}
            placeholder="Cuello, lado izquierdo"
            {...link()}
          />
          <NotesField draft={draft} set={set} />
        </>
      );

    case "microchip_replace":
      return (
        <>
          <Choice
            label="Motivo"
            required
            options={OWNER_MICROCHIP_REPLACE_REASONS}
            selected={draft.replaceReason}
            optionLabel={microchipReplaceReasonLabel}
            onSelect={(value) => set("replaceReason", value)}
          />
          {/* NOT REQUIRED, and the asymmetry is the rule: leaving the animal
              with no chip is a real outcome under two of the five motives. The
              contract refuses the combination the other three make invalid, and
              `MICROCHIP_REPLACE_NEW_CHIP_REQUIRED` is the sentence that names
              the way out. A `required` here would take that outcome away. */}
          <TextField
            label="Número del chip nuevo"
            mono
            value={draft.newChipNumber}
            invalid={invalid.has("newChipNumber")}
            onChangeText={(v) => set("newChipNumber", v)}
            placeholder="Dejalo vacío si no hay chip nuevo"
            autoCapitalize="none"
            autoCorrect={false}
            inputMode="numeric"
            {...link()}
          />
          <TextField
            label="Realizado por"
            value={draft.replacedBy}
            onChangeText={(v) => set("replacedBy", v)}
            {...link()}
          />
          {dateField("Fecha del reemplazo", "occurredAt", true)}
          <NotesField draft={draft} set={set} />
        </>
      );

    case "dangerous_breed_attestation": {
      // ALWAYS A CHOICE, NEVER A TEXT BOX, and the first version of this screen
      // got that wrong in a way worth recording: it fell back to a free-text
      // registry when the jurisdiction named none, on the belief that the web
      // does the same. The web does not, and neither does the server — the
      // accepted set is a MEMBERSHIP CHECK (`allowedAttestationRegistries`) and
      // it is never empty: with no jurisdiction override it falls back to the
      // national list plus `other`. A text box could therefore only ever
      // produce a 400, unless the person happened to type an internal id like
      // `caba_4078`. Caught in review the same day it was written.
      //
      // So the fallback here is the SAME fallback the server uses, and the
      // jurisdiction's own list replaces it when the payload carries one.
      // `attestationRegistryOptions` is the single answer to "what may be
      // chosen" — the reconciliation effect in `EventForm` asks it the same
      // question, and a second inline copy here is what let a stale draft
      // survive a list swap once already.
      const registries = attestationRegistryOptions(pppRegistries);
      return (
        <>
          <Choice
            label="Registro"
            required
            options={registries.map((r) => r.id)}
            selected={draft.registry.length > 0 ? draft.registry : null}
            optionLabel={(id) => registries.find((r) => r.id === id)?.label ?? id}
            onSelect={(value) => set("registry", value)}
          />
          <TextField
            label="Número de registro"
            value={draft.registryId}
            onChangeText={(v) => set("registryId", v)}
            autoCapitalize="characters"
            autoCorrect={false}
            {...link()}
          />
          {dateField("Fecha de la atestación", "occurredAt", true)}
          <NotesField draft={draft} set={set} />
        </>
      );
    }

    case "tattoo":
      return (
        <>
          <TextField
            label="Código del tatuaje"
            required
            mono
            value={draft.tattooCode}
            invalid={invalid.has("tattooCode")}
            onChangeText={(v) => set("tattooCode", v)}
            placeholder="Como está tatuado"
            autoCapitalize="characters"
            {...link()}
          />
          <Choice
            label="¿Dónde está?"
            options={TATTOO_LOCATION_OPTIONS}
            selected={draft.tattooLocation}
            optionLabel={tattooLocationLabel}
            onSelect={(value) => set("tattooLocation", value)}
          />
          {dateField("Fecha del tatuaje", "occurredAt", false)}
          {/* DICE QUE SE PUEDE BORRAR, porque el campo viene con la fecha de
              hoy como todos los demas y un tatuaje leido de un animal adoptado
              no tiene fecha conocida. El escritor asienta esa ausencia como un
              hecho (`tattoo_date_known: false`) en vez de inventar un dia. */}
          <Body>Si no sabés cuándo se lo hicieron, dejá la fecha vacía.</Body>
          <TextField
            label="Cómo es"
            value={draft.tattooDescription}
            onChangeText={(v) => set("tattooDescription", v)}
            placeholder="Letras, números, color…"
            {...link()}
          />
          <TextField
            label="Quién lo hizo"
            value={draft.tattooRecordedBy}
            onChangeText={(v) => set("tattooRecordedBy", v)}
            placeholder="La veterinaria, el refugio…"
            {...link()}
          />
        </>
      );

    case "bite":
      return (
        <>
          <Choice
            label="¿A quién mordió?"
            required
            options={BITE_VICTIM_KIND_OPTIONS}
            selected={draft.victimKind}
            optionLabel={biteVictimKindLabel}
            onSelect={(value) => set("victimKind", value)}
          />
          <Choice
            label="¿Qué tan grave fue?"
            required
            options={BITE_SEVERITY_OPTIONS}
            selected={draft.biteSeverity}
            optionLabel={biteSeverityLabel}
            onSelect={(value) => set("biteSeverity", value)}
          />
          {dateField("Fecha de la mordedura", "occurredAt", true)}
          {/* EL PUNTO, EN UN MAPA (M17). Donde OCURRIÓ la mordedura, puesto por
              la persona — nunca el GPS del teléfono. Confirmar llena la
              jurisdicción de abajo cuando el catálogo INDEC reconoce el punto,
              y el texto "Dónde pasó" si estaba vacío; los dos siguen editables. */}
          <LocationPicker
            label="Marcá dónde pasó"
            startQuery={petPlace}
            value={bitePickedLocation(draft)}
            onChange={(picked) => {
              set("biteLat", picked ? String(picked.lat) : "");
              set("biteLng", picked ? String(picked.lng) : "");
              set("biteLocationSource", picked ? picked.source : "");
              if (picked?.address && draft.locationDescription.trim() === "") {
                set("locationDescription", picked.address);
              }
              const j = picked?.jurisdiction;
              if (j?.localityIndecId) {
                set("biteProvinceCode", j.provinceCode);
                set("biteLocalityName", j.localityName);
                set("biteLocalityIndecId", j.localityIndecId);
                set("biteLocalityPicked", picked?.localityPicked === true);
              }
            }}
          />
          <TextField
            label="Dónde pasó"
            value={draft.locationDescription}
            onChangeText={(v) => set("locationDescription", v)}
            placeholder="La esquina, la plaza, el pasillo…"
            {...link()}
          />
          <TextField
            label="Qué estaba pasando"
            value={draft.biteContext}
            onChangeText={(v) => set("biteContext", v)}
            placeholder="En tus palabras"
            {...link()}
          />
          {/* LA JURISDICCIÓN DEL HECHO, NO LA DEL ANIMAL — decisión de producto,
              y la razón por la que este formulario tiene un selector que ningún
              otro tiene. Una mordedura en Córdoba de una mascota registrada en
              CABA es problema de la autoridad de Córdoba.
              OPCIONAL, y el pie dice qué pasa si se deja vacío, porque "no sé
              exactamente dónde" es una respuesta real y el respaldo es una
              conducta definida, no un agujero. */}
          <LocalityPicker
            provinceCode={draft.biteProvinceCode}
            localityName={draft.biteLocalityName}
            onSelect={(selection) => {
              set("biteProvinceCode", selection.provinceCode);
              set("biteLocalityName", selection.localityName);
              // Cuál de los 68 homónimos. Sin esto el servidor resuelve por
              // nombre y cae en el departamento alfabéticamente primero, así que
              // el caso se rutea a una autoridad que nadie eligió.
              set("biteLocalityIndecId", selection.localityIndecId);
              set("biteLocalityPicked", false);
            }}
          />
          <Body>Si la dejás vacía, la mordedura cuenta donde vive tu mascota.</Body>
          {/* THIRD-PARTY DATA: the name and phone of the person bitten, who
              never agreed to be on this phone. `NO_KEYBOARD_MEMORY` keeps them
              out of the keyboard's learned words and the OS autofill store,
              which would otherwise outlive the draft sweep. */}
          <TextField
            label="Nombre de quien fue mordido"
            value={draft.victimContactName}
            onChangeText={(v) => set("victimContactName", v)}
            placeholder="Opcional"
            {...NO_KEYBOARD_MEMORY}
            {...link()}
          />
          <TextField
            label="Teléfono de contacto"
            value={draft.victimContactPhone}
            onChangeText={(v) => set("victimContactPhone", v)}
            placeholder="Opcional"
            inputMode="tel"
            {...NO_KEYBOARD_MEMORY}
            {...link()}
          />
          <TextField
            label="Edad aproximada"
            value={draft.victimAgeEstimate}
            onChangeText={(v) => set("victimAgeEstimate", v)}
            placeholder="Opcional"
            {...link()}
          />
          <NotesField draft={draft} set={set} />
        </>
      );

    case "pregnancy_start":
      return (
        <>
          <TextField
            label="Semanas al diagnóstico"
            mono
            value={draft.weeksAtDiagnosis}
            invalid={invalid.has("weeksAtDiagnosis")}
            onChangeText={(v) => set("weeksAtDiagnosis", v)}
            placeholder="4"
            inputMode="numeric"
            {...link()}
          />
          {/* NOT REQUIRED, AND THE CAPTION SAYS WHY IT MAY BE LEFT BLANK.
              Somebody whose vet said "está preñada" without a week is not
              missing data — the server dates the birth from the full species
              gestation, which is the honest estimate when the week is unknown.
              A required field here would make them invent one, and the invented
              number moves the probable birth date and every checkup with it. */}
          <Body>
            Si no las sabés, dejá el campo vacío: la fecha probable de parto se calcula con la
            gestación completa de la especie.
          </Body>
          {dateField("Fecha del diagnóstico", "occurredAt", true)}
          <TextField
            label="Veterinario"
            value={draft.vetName}
            onChangeText={(v) => set("vetName", v)}
            placeholder="Quién lo confirmó"
            {...link()}
          />
          <NotesField draft={draft} set={set} />
        </>
      );

    case "pregnancy_end": {
      // THE COUNT IS GATED ON ONE OUTCOME AND CLEARED WITH IT, the same shape
      // the death form uses for its clinic and its disease. Somebody who typed
      // 4 crías and then changed the outcome to "se perdió el embarazo" must
      // not be left holding a number that is no longer on screen: the contract
      // refuses that combination outright, so keeping it would turn a changed
      // mind into a 400 about a field they cannot see.
      const liveBirth = draft.outcome === "live_birth";
      return (
        <>
          <Choice
            label="¿Cómo terminó?"
            required
            options={PREGNANCY_OUTCOME_OPTIONS}
            selected={draft.outcome}
            optionLabel={pregnancyOutcomeLabel}
            onSelect={(value) => {
              set("outcome", value);
              if (value !== "live_birth") set("liveBirthsCount", "");
            }}
          />
          {liveBirth ? (
            <TextField
              label="Crías nacidas con vida"
              required
              mono
              value={draft.liveBirthsCount}
              invalid={invalid.has("liveBirthsCount")}
              onChangeText={(v) => set("liveBirthsCount", v)}
              placeholder="4"
              inputMode="numeric"
              {...link()}
            />
          ) : null}
          {dateField("Fecha", "occurredAt", true)}
          <TextField
            label="Veterinario"
            value={draft.vetName}
            onChangeText={(v) => set("vetName", v)}
            placeholder="Quién atendió"
            {...link()}
          />
          <NotesField draft={draft} set={set} />
        </>
      );
    }

    case "death": {
      // THE ONLY FORM ON THIS SCREEN THAT CLOSES A RECORD, and the only one
      // whose fields appear and disappear as the person answers. Each reveal
      // mirrors the web's own conditional block; what does NOT mirror it is the
      // CLEARING below, which the web does not do and which this screen learned
      // three days ago from the PPP registry: when an answer stops applying,
      // the value it gated goes with it. Otherwise somebody names a clinic,
      // changes their mind about where the animal died, and ships a combination
      // the server refuses — about a field no longer on screen.
      const isDisease = draft.cause === "disease";
      const atClinic = draft.deathAtClinic === "si";
      const byVet = draft.confirmedByVet === "si";
      const diseases = deathDiseaseOptions(species);
      return (
        <>
          <Choice
            label="Causa"
            required
            options={DEATH_CAUSES}
            selected={draft.cause}
            optionLabel={deathCauseLabel}
            onSelect={(value) => {
              set("cause", value);
              if (value !== "disease") {
                set("diseaseCode", "");
                set("confirmedByLab", null);
              }
            }}
          />
          <TextField
            label="Detalle"
            value={draft.causeDetail}
            onChangeText={(v) => set("causeDetail", v)}
            placeholder="Lo que sepas, en tus palabras"
            {...link()}
          />
          {isDisease ? (
            <>
              <Choice
                label="Enfermedad"
                required
                options={diseases.map((d) => d.id)}
                selected={draft.diseaseCode.length > 0 ? draft.diseaseCode : null}
                optionLabel={diseaseLabel}
                onSelect={(value) => set("diseaseCode", value)}
              />
              <Choice
                label="¿Lo confirmó un laboratorio?"
                options={YES_NO}
                selected={draft.confirmedByLab}
                optionLabel={yesNoLabel}
                onSelect={(value) => set("confirmedByLab", value)}
              />
            </>
          ) : null}
          {dateField("Fecha del fallecimiento", "occurredAt", true)}
          <Choice
            label="¿Falleció en una veterinaria?"
            options={YES_NO}
            selected={draft.deathAtClinic}
            optionLabel={yesNoLabel}
            onSelect={(value) => {
              set("deathAtClinic", value);
              if (value !== "si") {
                set("clinicName", "");
                set("vetContactedOwner", null);
                set("vetDecidedAlone", null);
              }
            }}
          />
          {atClinic ? (
            <>
              <TextField
                label="Nombre de la veterinaria"
                value={draft.clinicName}
                invalid={invalid.has("clinicName")}
                onChangeText={(v) => set("clinicName", v)}
                {...link()}
              />
              <Choice
                label="¿El veterinario te contactó?"
                options={VET_CONTACT_VALUES}
                selected={draft.vetContactedOwner}
                optionLabel={vetContactLabel}
                onSelect={(value) => {
                  set("vetContactedOwner", value);
                  if (value !== "no") set("vetDecidedAlone", null);
                }}
              />
              {draft.vetContactedOwner === "no" ? (
                <Choice
                  label="¿Decidió sin consultarte?"
                  options={YES_NO}
                  selected={draft.vetDecidedAlone}
                  optionLabel={yesNoLabel}
                  onSelect={(value) => set("vetDecidedAlone", value)}
                />
              ) : null}
            </>
          ) : null}
          <Choice
            label="¿Lo confirmó un veterinario?"
            options={YES_NO}
            selected={draft.confirmedByVet}
            optionLabel={yesNoLabel}
            onSelect={(value) => {
              set("confirmedByVet", value);
              if (value !== "si") set("vetName", "");
            }}
          />
          {byVet ? (
            <TextField
              label="Nombre del veterinario"
              value={draft.vetName}
              onChangeText={(v) => set("vetName", v)}
              {...link()}
            />
          ) : null}
          <Choice
            label="¿Qué se hizo con el cuerpo?"
            options={DISPOSITION_METHODS}
            selected={draft.dispositionMethod}
            optionLabel={dispositionMethodLabel}
            onSelect={(value) => set("dispositionMethod", value)}
          />
          <Choice
            label="¿Lo llevaste a un crematorio privado?"
            options={YES_NO}
            selected={draft.ownerToPrivateCrematorium}
            optionLabel={yesNoLabel}
            onSelect={(value) => set("ownerToPrivateCrematorium", value)}
          />
          <TextField
            label="Establecimiento"
            value={draft.facility}
            onChangeText={(v) => set("facility", v)}
            {...link()}
          />
          <NotesField draft={draft} set={set} />
        </>
      );
    }

    case "note":
      return (
        <>
          <TextField
            label="Nota"
            required
            multiline
            value={draft.text}
            invalid={invalid.has("text")}
            onChangeText={(v) => set("text", v)}
          />
          {dateField("Fecha", "occurredAt", true)}
          <Choice
            label="Categoría"
            options={NOTE_CATEGORY_OPTIONS}
            selected={draft.category}
            optionLabel={noteCategoryLabel}
            onSelect={(value) => set("category", draft.category === value ? null : value)}
          />
        </>
      );

    case "symptom":
      return (
        <>
          {/* THE FIELD THAT DOES THE WORK. The server's matcher reads THIS —
              not the severity, not the date — so the placeholder asks for
              observations and not for a diagnosis. A person writing "parvovirus"
              here has guessed; a person writing what they saw has reported. */}
          <TextField
            label="Qué le viste"
            required
            multiline
            value={draft.freeText}
            invalid={invalid.has("freeText")}
            onChangeText={(v) => set("freeText", v)}
            placeholder="Decaído, no come desde ayer, vómitos"
          />
          <Choice
            label="Gravedad"
            options={SYMPTOM_SEVERITY_OPTIONS}
            selected={draft.severity}
            optionLabel={symptomSeverityLabel}
            onSelect={(value) => set("severity", draft.severity === value ? null : value)}
          />
          {/* OPTIONAL AND BLANK, unlike every other date on this screen. Left
              empty, the asiento is stamped at the moment of reporting — which
              is the honest answer when nobody knows when it started. */}
          {dateField("Desde cuándo (si sabés)", "onsetAt", false)}
        </>
      );

    case "post_adoption_checkin":
      return (
        <>
          {/* THE WEB'S ONE FIELD, WITH THE WEB'S OWN QUESTION (CheckinForm.tsx).
              Not `NotesField`: "Notas" is a footnote to an asiento about
              something else, and here the text IS the asiento. Optional, as
              on the web — "estamos bien" with nothing typed is a real answer. */}
          <TextField
            label="¿Cómo está?"
            multiline
            value={draft.notes}
            onChangeText={(v) => set("notes", v)}
            placeholder="Salud, ánimo, adaptación al hogar… lo que el refugio querría saber."
          />
          {/* D7 (2026-09-25): ya no dice "la foto se hace desde la web" — el
              boton de `TattooPhotoField` mas abajo (fuera de `Fields`, ver su
              propio comentario) es esa affordance ahora. Lo unico que queda
              por decir aca es lo que la foto no cambia: cuando se manda. */}
          <Body>Se envía sin fecha: queda con el momento en que lo mandás.</Body>
        </>
      );
  }
}

function NotesField({
  draft,
  set,
}: {
  draft: EventDraft;
  set: <K extends keyof EventDraft>(field: K, value: EventDraft[K]) => void;
}) {
  return (
    <TextField
      label="Notas"
      multiline
      value={draft.notes}
      onChangeText={(v) => set("notes", v)}
      placeholder="Opcional"
    />
  );
}

// `Choice` USED TO LIVE HERE and now lives in `kit.tsx`. Its docblock said it
// would move "the day a second screen needs it"; the transfer form (WU-O) is
// that screen, so it moved rather than being copied.

const styles = StyleSheet.create({
  // Cuadrada, como la vista previa de `PetPhotoScreen`: lo que se mira acá es
  // si la marca se lee, y un recorte apaisado corta justo las orejas.
  tattooPreview: {
    width: "100%",
    aspectRatio: 1,
    borderRadius: RADIUS.control,
    backgroundColor: COLORS.stripe,
  },
  header: { gap: SPACE.xs },
});
