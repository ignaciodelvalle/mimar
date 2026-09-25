// DENUNCIAR MALTRATO — Ley 14.346, desde el teléfono.
//
// THIS IS NOT A FEEDBACK FORM AND THE SCREEN SAYS SO BEFORE IT ASKS ANYTHING.
// What it files is an unverified allegation of a crime that carries prison,
// against a person the reporter is about to describe, routed to the authority of
// the jurisdiction the point falls in. Nobody can retract it afterwards. So the
// screen opens with two things that would be footnotes on a moderation form and
// are preconditions here: what "anónima" does and does not buy, and the fact
// that evidence cannot be attached from this app — EVER, not "yet in this
// session", because the server accepts evidence only at creation.
//
// TWO STEPS, AND THE FIRST ONE IS THE PLACE
// ---------------------------------------------------------------------------
//   1. ¿DÓNDE? The person types an address, the server resolves it through the
//      web's own geocoder, and they TAP the candidate they mean. That tap is
//      what produces the coordinates the intake requires.
//   2. QUÉ PASÓ. Everything else, then send.
//
// The place is first and not last, deliberately, and this is the one ordering
// decision on the screen that is not the web's: `/denuncias/nueva` asks for the
// kind first and the place third. Here the place can FAIL — the geocoder may
// know nothing about the street somebody typed — and a failure that arrives
// after five minutes of testimony is a failure that loses the testimony. On the
// web the address field cannot fail in that way, because the map pin is always
// available underneath it.
//
// THE MAP PIN IS THE THING THIS SCREEN DOES NOT HAVE, and it is the honest gap
// rather than a rendering shortcut. `expo-location` and any map component are
// native modules, which is an EAS build — the pipeline the board records as six
// builds with five distinct root causes. So the point comes from a list somebody
// chooses from, never from a pin they drag and never from a guess this app made.
// When a native build lands, the pin is strictly additive: it would set the same
// three values (`lat`, `lng`, `label`) that tapping a candidate sets.
//
// NOTHING HERE DECIDES WHAT IS ANONYMOUS. The wire shape does: the anonymous
// command has no contact fields, so this screen cannot send one under it even by
// mistake — see `@dim/contract/input`'s `welfare-report.ts`.

import * as Linking from "expo-linking";
import { useCallback, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import type { WelfareLocationMatchV1 } from "@dim/contract/api";
import type {
  WelfareReportCitizenSeverity,
  WelfareReportKind,
  WelfareReportSubjectKind,
} from "@dim/contract/input";
import {
  WELFARE_EVIDENCE_MAX_FILES,
  WELFARE_REPORT_CITIZEN_SEVERITIES,
  WELFARE_REPORT_KINDS,
  WELFARE_REPORT_SUBJECT_KINDS,
} from "@dim/contract/input";

import { apiFailureMessage } from "../api/client";
import { sendWelfareReportCommand } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { ASYNC_IMAGE_PICK_MARKER_STORE } from "../native/image-pick-marker-store";
import { getImagePickerPort, pickImageSafely } from "../native/image-picker-port";
import { type AcceptedImage, acceptPickedImage } from "../pets/pet-photo-view-model";
import { Body } from "../ui/components";
import {
  Callout,
  Choice,
  LinkText,
  PrimaryButton,
  Screen,
  SecondaryButton,
  Subtitle,
  TextField,
  Title,
} from "../ui/kit";
import { COLORS, RADIUS, SPACE, TOUCH_TARGET, TYPE } from "../ui/theme";
import { useDraftDiscardGuard } from "../ui/use-draft-discard-guard";
import { useReturnKeyChain } from "../ui/use-return-key-chain";
import { useScrollToError } from "../ui/use-scroll-to-error";

import {
  DENUNCIA_ANONYMOUS_CAVEAT,
  DENUNCIA_EVIDENCE_NOTE,
  DENUNCIA_NO_MATCHES,
  type DenunciaFormValues,
  buildFileDenunciaCommand,
  buildResolveLocationCommand,
  denunciaInputMessage,
  denunciaKindLabel,
  denunciaMissingMessage,
  denunciaSeverityHint,
  denunciaSeverityLabel,
  denunciaSubjectLabel,
  denunciaSubjectPlaceholder,
  missingDenunciaFields,
} from "./denuncia-view-model";
import { type StagedEvidence, stageDenunciaPhoto } from "./evidence-flow";

const EMPTY: DenunciaFormValues = {
  kind: null,
  severity: null,
  description: "",
  subjectKind: null,
  subjectDescription: "",
  place: null,
  anonymous: true,
  contactEmail: "",
  contactPhone: "",
  evidence: [],
};

/**
 * The evidence block's own state (M12). `failed` KEEPS the picked image, so
 * "Reintentar" re-uploads the same photo instead of making the person find it
 * again — and the form stays sendable without it.
 */
type EvidenceState =
  | { name: "idle"; message: string | null }
  | { name: "uploading" }
  | { name: "failed"; message: string; image: AcceptedImage };

type Phase =
  | { name: "form"; error: string | null }
  | { name: "working" }
  | { name: "filed"; referenceCode: string; followUpUrl: string };

export function DenunciaScreen() {
  const [values, setValues] = useState<DenunciaFormValues>(EMPTY);
  const [phase, setPhase] = useState<Phase>({ name: "form", error: null });
  // `scrollRef` and not the context: this component RENDERS the Screen, so it
  // sits above the provider and `useContext` answered null here — the scroll
  // never fired once (forms-F4). See `use-scroll-to-error.ts`.
  const { anchorRef: errorAnchor, scrollRef } = useScrollToError(
    phase.name === "form" ? phase.error : null,
  );
  const [addressText, setAddressText] = useState("");
  const [matches, setMatches] = useState<WelfareLocationMatchV1[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  // Bumped by "Hacer otra denuncia" so the photo block starts empty again.
  const [evidenceEpoch, setEvidenceEpoch] = useState(0);
  // THE BACK GESTURE MAY NOT DISCARD A TYPED DENUNCIA (critic gap 2). This is
  // the longest thing a citizen writes in this app and the only one that cannot
  // be re-read from the server afterwards. `filed` clears the guard: the
  // allegation is on record and the screen is a receipt.
  useDraftDiscardGuard(phase.name !== "filed" && (values !== EMPTY || addressText !== ""));

  const patch = useCallback((next: Partial<DenunciaFormValues>) => {
    setValues((current) => ({ ...current, ...next }));
    setPhase((current) => (current.name === "form" ? { name: "form", error: null } : current));
  }, []);

  const searchPlace = useCallback(async () => {
    const draft = buildResolveLocationCommand(addressText);
    if (!draft.ok) {
      setPhase({ name: "form", error: denunciaInputMessage(draft.code) });
      return;
    }
    setSearching(true);
    const result = await sendWelfareReportCommand(sessionPort, draft.input);
    setSearching(false);

    if (result.outcome !== "ok") {
      setPhase({
        name: "form",
        error: apiFailureMessage(result) ?? "No pudimos enviar la denuncia.",
      });
      return;
    }
    if (result.payload.command !== "resolve_location") {
      // The server answered the other command. Unreachable, and it still gets a
      // sentence: a screen that renders nothing is a screen somebody taps twice.
      setPhase({ name: "form", error: "No pudimos buscar esa dirección. Probá de nuevo." });
      return;
    }
    setMatches(result.payload.matches);
  }, [addressText]);

  const send = useCallback(async () => {
    // IN FIELD ORDER, AND ALL OF THEM (B-07). The contract's parse answers with
    // the first issue ZOD found, which follows the schema's key order and has
    // nothing to do with where the field sits on the phone — so an empty form
    // pointed at "¿Qué está pasando?" while the heading above it was just as
    // empty. This runs first and names every gap, top to bottom; the parse below
    // is still the single door for every rule about CONTENT.
    const missing = denunciaMissingMessage(missingDenunciaFields(values, addressText));
    if (missing !== null) {
      setPhase({ name: "form", error: missing });
      return;
    }
    const draft = buildFileDenunciaCommand(values);
    if (!draft.ok) {
      setPhase({ name: "form", error: denunciaInputMessage(draft.code) });
      return;
    }
    setPhase({ name: "working" });
    const result = await sendWelfareReportCommand(sessionPort, draft.input);

    if (result.outcome !== "ok") {
      setPhase({
        name: "form",
        error: apiFailureMessage(result) ?? "No pudimos enviar la denuncia.",
      });
      return;
    }
    if (result.payload.command !== "file") {
      setPhase({ name: "form", error: "No pudimos enviar la denuncia. Probá de nuevo." });
      return;
    }
    setPhase({
      name: "filed",
      referenceCode: result.payload.referenceCode,
      followUpUrl: result.payload.followUpUrl,
    });
  }, [addressText, values]);

  // Return-key advance (M10, native-feel audit) — TWO independent chains, not
  // one across the whole form: the address field's own "next step" is the
  // search button, not another field, and the two multiline fields between
  // them (`subjectDescription`, `description`) keep the newline their return
  // key has always typed — chaining THROUGH a multiline field is exactly what
  // `useReturnKeyChain`'s own header says never to do. Neither chain
  // auto-submits the denuncia itself: `send` needs an explicit tap, the same
  // reason `EditProfileScreen`'s chain does not either — a legal allegation
  // that "una vez enviada, no se puede borrar" is not something a keyboard key
  // should file by accident.
  const searchChain = useReturnKeyChain(1, () => void searchPlace());
  const contactChain = useReturnKeyChain(2);

  if (phase.name === "filed") {
    return (
      <Screen>
        <Title>Denuncia registrada</Title>
        <Callout tone="ok" title="Guardá este código">
          {/* selectable: "guardá este código" must not mean "transcribílo a
              mano" — long-press copies it into the note or chat where it will
              actually be kept. */}
          <Body selectable>{phase.referenceCode}</Body>
        </Callout>
        <Subtitle>
          Con ese código podés confirmar que la denuncia está registrada y pedir acceso al
          seguimiento. Es un número de constancia: por sí solo no muestra nada de la denuncia.
        </Subtitle>
        {values.anonymous ? (
          <Callout tone="warn" title="La enviaste de forma anónima">
            <Body>
              No guardamos ningún dato tuyo, así que no tenemos a dónde escribirte. El código es lo
              único que te vincula con la denuncia: si lo perdés, no vas a poder seguirla.
            </Body>
          </Callout>
        ) : (
          <Callout tone="neutral" title="Para seguir la denuncia">
            <Body>
              Te vamos a pedir el correo que dejaste. El enlace de acceso se envía sólo a esa
              dirección.
            </Body>
          </Callout>
        )}
        <LinkText
          accessibilityHint="Se abre en el navegador"
          onPress={() => void Linking.openURL(phase.followUpUrl)}
        >
          Ver la constancia en la web
        </LinkText>
        <SecondaryButton
          label="Hacer otra denuncia"
          onPress={() => {
            setValues(EMPTY);
            setAddressText("");
            setMatches(null);
            setEvidenceEpoch((epoch) => epoch + 1);
            setPhase({ name: "form", error: null });
          }}
        />
      </Screen>
    );
  }

  const working = phase.name === "working";

  return (
    <Screen keyboardAvoiding scrollRef={scrollRef}>
      <Title>Denunciar maltrato</Title>
      <Subtitle>
        La denuncia va a la autoridad de la zona donde ocurre. Es un trámite con consecuencias
        legales (Ley 14.346): una vez enviada, no se puede borrar.
      </Subtitle>

      {/* ---- 1. El lugar ------------------------------------------------- */}

      <TextField
        {...searchChain(0)}
        label="¿Dónde está pasando?"
        required
        editable={!working && !searching}
        placeholder="Calle y número, o una esquina"
        value={addressText}
        onChangeText={(next) => {
          setAddressText(next);
          // A NEW SEARCH INVALIDATES THE CHOSEN POINT. Leaving the previous
          // place selected while the address field says something else is how a
          // denuncia gets filed against the wrong street.
          if (values.place !== null) patch({ place: null });
          setMatches(null);
        }}
      />
      <SecondaryButton
        label={searching ? "Buscando…" : "Buscar el lugar"}
        disabled={working || searching || addressText.trim().length < 3}
        onPress={() => void searchPlace()}
      />

      {matches !== null && matches.length === 0 ? (
        <Callout tone="neutral">
          <Body>{DENUNCIA_NO_MATCHES}</Body>
        </Callout>
      ) : null}

      {matches !== null && matches.length > 0 ? (
        <View style={styles.matches} accessibilityRole="radiogroup">
          {matches.map((match) => {
            // THE SAME TRIPLE THE key USES (A5-ciudadanas-13). Comparing on the
            // label alone lit BOTH rows when the geocoder returned two entries
            // with an identical display_name — which it does for a corner — and
            // the point actually filed was whichever was tapped. A highlight
            // that does not identify the chosen row is worse than none.
            const active =
              values.place !== null &&
              values.place.lat === match.lat &&
              values.place.lng === match.lng &&
              values.place.label === match.label;
            return (
              <Pressable
                key={`${match.lat},${match.lng},${match.label}`}
                accessibilityRole="radio"
                accessibilityState={{ checked: active }}
                onPress={() =>
                  patch({
                    place: {
                      label: match.label,
                      lat: match.lat,
                      lng: match.lng,
                      province: match.province,
                      locality: match.locality,
                    },
                  })
                }
                style={[styles.match, active ? styles.matchActive : null]}
              >
                <Text style={active ? styles.matchLabelActive : styles.matchLabel}>
                  {match.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {/* ---- 2. Qué pasó ------------------------------------------------- */}

      <Choice
        label="¿Qué está pasando?"
        required
        options={WELFARE_REPORT_KINDS}
        selected={values.kind}
        optionLabel={denunciaKindLabel}
        disabled={working}
        onSelect={(kind: WelfareReportKind) => patch({ kind })}
      />

      <Choice
        label="¿Qué tan grave es?"
        required
        options={WELFARE_REPORT_CITIZEN_SEVERITIES}
        selected={values.severity}
        optionLabel={denunciaSeverityLabel}
        disabled={working}
        onSelect={(severity: WelfareReportCitizenSeverity) => patch({ severity })}
      />
      {values.severity === null ? null : (
        <Subtitle>{denunciaSeverityHint(values.severity)}</Subtitle>
      )}

      {/* THE EMERGENCY OFF-RAMP, copied from the web's own Step 2. A denuncia
          is asynchronous; an animal in immediate danger needs a phone call, and
          the form must not stand in front of that. */}
      {values.severity === "critical" ? (
        <Callout tone="err" title="Si hay peligro inmediato">
          <Body>
            Llamá al 911. Esta denuncia queda registrada y la revisa la autoridad, pero no es una
            urgencia que alguien atienda en el momento.
          </Body>
        </Callout>
      ) : null}

      <Choice
        label="¿Sobre qué es la denuncia?"
        required
        options={WELFARE_REPORT_SUBJECT_KINDS}
        selected={values.subjectKind}
        optionLabel={denunciaSubjectLabel}
        disabled={working}
        onSelect={(subjectKind: WelfareReportSubjectKind) => patch({ subjectKind })}
      />

      <TextField
        label="¿Qué o a quién estás denunciando?"
        required
        multiline
        editable={!working}
        placeholder={
          values.subjectKind === null
            ? "Describí brevemente lo que viste"
            : denunciaSubjectPlaceholder(values.subjectKind)
        }
        value={values.subjectDescription}
        onChangeText={(subjectDescription) => patch({ subjectDescription })}
      />

      <TextField
        label="Contanos qué pasó"
        required
        multiline
        editable={!working}
        placeholder="Qué viste, cuándo, cuánto hace que pasa"
        value={values.description}
        onChangeText={(description) => patch({ description })}
      />

      {/* NO "¿NOTASTE SÍNTOMAS?" FIELD — but the reason CHANGED on 2026-09-01
          and the old one must not be cited. This screen carried the field for
          most of a day while `welfare_reports` had no column, so the answer
          went nowhere and the field was removed as a repair. Migration 0209
          closed that hole (campo propio, PO decision): the wire accepts
          `observedSymptoms` again and the server now stores and shows it. The
          field stays OFF this screen as product scope — the citizen wizard on
          the web does not ask either, and adding a question both citizen doors
          skip is a product decision, not a transport one. Meanwhile "Contanos
          qué pasó" remains the place a reporter's observations reach the
          operator and the MPF export. */}

      {/* ---- 3. Cómo la enviás -------------------------------------------- */}

      <Choice
        label="¿Cómo querés enviarla?"
        required
        options={["anonymous", "with_contact"] as const}
        selected={values.anonymous ? "anonymous" : "with_contact"}
        optionLabel={(mode) => (mode === "anonymous" ? "Anónima" : "Con mi contacto")}
        disabled={working}
        onSelect={(mode) => patch({ anonymous: mode === "anonymous" })}
      />

      {values.anonymous ? (
        <Callout tone="neutral" title="Qué significa anónima">
          <Body>{DENUNCIA_ANONYMOUS_CAVEAT}</Body>
        </Callout>
      ) : (
        <>
          <TextField
            {...contactChain(0)}
            label="Correo"
            autoComplete="email"
            editable={!working}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="para que puedan escribirte"
            value={values.contactEmail}
            onChangeText={(contactEmail) => patch({ contactEmail })}
          />
          <TextField
            {...contactChain(1)}
            label="Teléfono"
            autoComplete="tel"
            editable={!working}
            keyboardType="phone-pad"
            placeholder="opcional si dejás un correo"
            value={values.contactPhone}
            onChangeText={(contactPhone) => patch({ contactPhone })}
          />
        </>
      )}

      {/* ---- Fotos (M12) ------------------------------------------------ */}
      <EvidenceSection
        key={evidenceEpoch}
        disabled={working}
        onChange={(evidence) => patch({ evidence })}
        onBusyChange={setUploadingPhoto}
      />

      {phase.name === "form" && phase.error !== null ? (
        // Anchored for useScrollToError — same rationale as RecordEventScreen:
        // this form is long enough for the refusal to land out of view.
        <View ref={errorAnchor}>
          <Callout tone="err">
            <Body>{phase.error}</Body>
          </Callout>
        </View>
      ) : null}

      <PrimaryButton
        label={working ? "Enviando…" : "Enviar la denuncia"}
        // Not while a photo is mid-upload: sending then would file without it.
        disabled={working || searching || uploadingPhoto}
        onPress={() => void send()}
      />
    </Screen>
  );
}

/**
 * The photo block (M12), as its own component so the screen stays readable:
 * pick → stage → list, with its own failure and retry. It reports the staged
 * keys up (`onChange`) and whether an upload is in flight (`onBusyChange`), so
 * the send button waits for a photo instead of filing without it.
 */
function EvidenceSection({
  disabled,
  onChange,
  onBusyChange,
}: {
  disabled: boolean;
  onChange: (evidence: string[]) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [photos, setPhotos] = useState<StagedEvidence[]>([]);
  const [evidenceState, setEvidenceState] = useState<EvidenceState>({
    name: "idle",
    message: null,
  });
  const working = disabled;

  const setPhotoList = useCallback(
    (next: StagedEvidence[]) => {
      setPhotos(next);
      onChange(next.map((photo) => photo.stagedPath));
    },
    [onChange],
  );

  const uploadPhoto = useCallback(
    async (image: AcceptedImage) => {
      setEvidenceState({ name: "uploading" });
      onBusyChange(true);
      const staged = await stageDenunciaPhoto(sessionPort, image);
      onBusyChange(false);
      if (staged.outcome === "failed") {
        setEvidenceState({ name: "failed", message: staged.message, image });
        return;
      }
      setPhotoList([...photos, staged.evidence]);
      setEvidenceState({ name: "idle", message: null });
    },
    [onBusyChange, photos, setPhotoList],
  );

  const addPhoto = useCallback(async () => {
    // NO RECOVERY MARKER (`null`): the pet-photo and tattoo screens can resume a
    // pick an Android process death interrupted, and this one does not try —
    // a stray photo landing on a legal filing after a restart is worse than
    // asking again.
    const picked = acceptPickedImage(await pickImageSafely(null, ASYNC_IMAGE_PICK_MARKER_STORE));
    if (!picked.ok) {
      setEvidenceState({ name: "idle", message: picked.message });
      return;
    }
    await uploadPhoto(picked.image);
  }, [uploadPhoto]);

  const removePhoto = (stagedPath: string) =>
    setPhotoList(photos.filter((photo) => photo.stagedPath !== stagedPath));

  return (
    <>
      <Subtitle>Fotos (opcional)</Subtitle>
      <Body>{DENUNCIA_EVIDENCE_NOTE}</Body>

      {photos.map((photo, index) => (
        <View key={photo.stagedPath} style={styles.photoRow}>
          {photo.previewUri ? (
            <Image
              source={{ uri: photo.previewUri }}
              style={styles.photoThumb}
              accessibilityIgnoresInvertColors
            />
          ) : null}
          <Text style={styles.photoLabel}>Foto {index + 1}</Text>
          <LinkText onPress={() => removePhoto(photo.stagedPath)}>Quitar</LinkText>
        </View>
      ))}

      {evidenceState.name === "failed" ? (
        <Callout tone="err">
          <Body>{evidenceState.message}</Body>
          <View style={styles.spacer} />
          <LinkText onPress={() => void uploadPhoto(evidenceState.image)}>Reintentar</LinkText>
        </Callout>
      ) : null}
      {evidenceState.name === "idle" && evidenceState.message !== null ? (
        <Callout tone="warn">
          <Body>{evidenceState.message}</Body>
        </Callout>
      ) : null}

      {/* THE CONTROL IS DRAWN ONLY WHEN IT CAN WORK — the picker port's rule:
          a build without the module gets a sentence, not a dead button. */}
      {getImagePickerPort().available ? (
        photos.length < WELFARE_EVIDENCE_MAX_FILES ? (
          <SecondaryButton
            label={evidenceState.name === "uploading" ? "Subiendo la foto…" : "Agregar una foto"}
            disabled={working || evidenceState.name === "uploading"}
            onPress={() => void addPhoto()}
          />
        ) : null
      ) : (
        <Body>En esta versión de la app todavía no se pueden sumar fotos.</Body>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  spacer: { height: SPACE.xs },
  matches: { gap: SPACE.xs },
  match: {
    minHeight: TOUCH_TARGET,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.control,
    paddingVertical: SPACE.sm,
    paddingHorizontal: SPACE.md,
    backgroundColor: COLORS.surface,
  },
  matchActive: { borderColor: COLORS.accent, backgroundColor: COLORS.stripe },
  matchLabel: { fontSize: TYPE.sm, color: COLORS.inkSoft },
  matchLabelActive: { fontSize: TYPE.sm, color: COLORS.ink },
  photoRow: { flexDirection: "row", alignItems: "center", gap: SPACE.md },
  photoThumb: { width: TOUCH_TARGET, height: TOUCH_TARGET, borderRadius: RADIUS.control },
  photoLabel: { flex: 1, fontSize: TYPE.sm, color: COLORS.ink },
});
