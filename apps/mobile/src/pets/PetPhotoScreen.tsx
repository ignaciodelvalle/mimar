// LA FOTO DE LA CREDENCIAL — elegirla, mirarla, subirla. Detrás de la costura.
//
// THE WHOLE SCREEN IS WRITTEN AND TESTED AGAINST `image-picker-port.ts`. In a
// build without `expo-image-picker` (every build until the PO ships the EAS
// build the handback doc describes) the port is the honest default: this
// screen draws a callout naming the web instead of a control that cannot work,
// which is the same rule the claim screen follows for its scanner. The day the
// module ships, `setImagePickerPort()` runs at bootstrap and every state below
// simply becomes reachable — nothing here changes.
//
// REVIEW BEFORE UPLOAD, deliberately. The OS picker returns and the bytes stay
// on the device while the person looks at a preview and decides. Two reasons:
// the upload costs real data on a phone plan and the review step is where a
// wrong tap gets caught for free; and the credential is the animal's public
// face, so "¿es esta?" is worth one screen. The web's edit form does the same
// with its preview box.
//
// THE THREE NETWORK STEPS LIVE IN `pet-photo-upload-flow.ts`, the words in
// `pet-photo-view-model.ts`, and this file only decides what each outcome
// looks like. A failure lands back on the REVIEW step with the picked photo
// intact: whatever failed, the person still holds the photo, and the next
// thing they will do is try again — re-picking would punish them for a network
// error.

import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";

import type { PetPhotoUpdatedV1 } from "@dim/contract/api";

import { getSessionState, sessionPort } from "../auth/session-store";
import { ASYNC_IMAGE_PICK_MARKER_STORE } from "../native/image-pick-marker-store";
import {
  getImagePickerPort,
  pickImageSafely,
  recoverPendingPickSafely,
} from "../native/image-picker-port";
import { Body } from "../ui/components";
import { Callout, PrimaryButton, Screen, SecondaryButton, Subtitle, Title } from "../ui/kit";
import { COLORS, RADIUS, SPACE, TYPE } from "../ui/theme";

import { runPetPhotoUpload } from "./pet-photo-upload-flow";
import {
  type AcceptedImage,
  type PetPhotoUploadStep,
  acceptPickedImage,
  petPhotoFailureMessage,
  petPhotoStepLabel,
} from "./pet-photo-view-model";

type ScreenState =
  | { phase: "choosing"; error: string | null }
  /** The OS picker is up. Its UI is the module's; this screen just waits. */
  | { phase: "picking" }
  | { phase: "review"; image: AcceptedImage; error: string | null }
  | { phase: "uploading"; image: AcceptedImage; step: PetPhotoUploadStep }
  | { phase: "done"; photo: PetPhotoUpdatedV1 };

/**
 * The signed-in person's id, or `null` when nobody is — read fresh rather than
 * subscribed to, the same choice `use-event-draft.ts`'s own `currentOwnerId`
 * makes and for the same reason: this screen is behind `useGate`, so the
 * session is already resolved by the time it mounts. `null` here means "skip
 * the marker" below, not "block the pick" — see `pickImageSafely`'s own note
 * on that arm (T3-R4, 2026-09-22).
 */
function currentSessionUserId(): string | null {
  const state = getSessionState();
  return state.phase === "signed-in" ? state.user.id : null;
}

export function PetPhotoScreen({ publicToken }: { publicToken: string }) {
  const router = useRouter();
  const [state, setState] = useState<ScreenState>({ phase: "choosing", error: null });
  /** T4-M1 (2026-09-22): guards the recovery effect below against StrictMode's
   *  mount → unmount → mount — the same reason `launch-update-gate.ts` keeps
   *  a `started` ref: a test port (unlike the real adapter) is not
   *  claim-once by itself, so the synthetic remount could ask twice. */
  const startedRecovery = useRef(false);

  const pick = useCallback(async () => {
    setState({ phase: "picking" });
    // `pickImageSafely` AND NOT `getImagePickerPort().pickImage()`: this await
    // is bare, and a port that threw would leave the screen on `picking`
    // forever — a spinner with no sentence and no way out but hardware back.
    // The port's own header calls that the one answer a tap may not get, so the
    // enforcement lives at the seam and every caller goes through it.
    //
    // THE MARKER (T3-R4, 2026-09-22): written to disk before the native picker
    // opens, so a recovery after a process death can be checked against THIS
    // pet and THIS session before it is ever shown. See `image-picker-port.ts`.
    const sessionUserId = currentSessionUserId();
    const result = await pickImageSafely(
      sessionUserId === null ? null : { screen: "pet-photo", publicToken, sessionUserId },
      ASYNC_IMAGE_PICK_MARKER_STORE,
    );
    const outcome = acceptPickedImage(result);
    if (outcome.ok) {
      setState({ phase: "review", image: outcome.image, error: null });
      return;
    }
    // `message: null` is a cancel: back to the start with nothing to say.
    setState({ phase: "choosing", error: outcome.message });
  }, [publicToken]);

  // T4-M1 (2026-09-22): A PICK ANDROID ALREADY FINISHED BEFORE THIS SCREEN
  // EXISTED. See `expo-image-picker-adapter.ts`'s header for the whole design
  // decision — the short of it: `app/_layout.tsx` started this read at
  // bootstrap, and this mount is the earliest point this screen can claim it.
  //
  // THE FUNCTIONAL `setState` IS LOAD-BEARING. The await below can resolve
  // after the person has already tapped "Elegir una foto" for a NEW pick —
  // this effect must not clobber that in-flight attempt, or a photo Android
  // recovered from before the screen even opened could overwrite one the
  // person is actively choosing right now. Only a screen still sitting in its
  // untouched entry state may be advanced by a recovered pick.
  //
  // BOUND TO THIS PET AND THIS SESSION (T3-R4, 2026-09-22). A marker mismatch
  // — a different pet, a different signed-in person, a different screen, or
  // one simply too old — is `recoverPendingPickSafely` answering `null`, which
  // this effect already treats exactly like "nothing to recover". No session
  // means nothing to bind the marker to, so the call is skipped rather than
  // guessed at; the native pending result (if any) is drained the next time a
  // signed-in screen asks.
  useEffect(() => {
    if (startedRecovery.current) return;
    startedRecovery.current = true;
    let cancelled = false;
    void (async () => {
      const sessionUserId = currentSessionUserId();
      if (sessionUserId === null) return;
      const recovered = await recoverPendingPickSafely(
        { screen: "pet-photo", publicToken, sessionUserId },
        ASYNC_IMAGE_PICK_MARKER_STORE,
      );
      if (cancelled || recovered === null) return;
      const outcome = acceptPickedImage(recovered);
      setState((current) => {
        // "choosing" is the only phase with no live pick in progress — every
        // other phase (picking, review, uploading, done) means the person has
        // already moved past whatever Android recovered, or is mid-attempt on
        // a fresh one, and a stale recovery must not step on either.
        if (current.phase !== "choosing") return current;
        return outcome.ok
          ? { phase: "review", image: outcome.image, error: null }
          : { phase: "choosing", error: outcome.message };
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [publicToken]);

  const upload = useCallback(
    async (image: AcceptedImage) => {
      const result = await runPetPhotoUpload(sessionPort, publicToken, image, (step) =>
        setState({ phase: "uploading", image, step }),
      );
      if (result.outcome === "done") {
        setState({ phase: "done", photo: result.photo });
        return;
      }
      // BACK TO REVIEW WITH THE PHOTO INTACT — see the header. The sentence
      // already says what a retry would honestly do for this particular failure.
      setState({ phase: "review", image, error: petPhotoFailureMessage(result.failure) });
    },
    [publicToken],
  );

  // THE BUILD WITHOUT THE MODULE. Read fresh on every render (a test swaps the
  // port per case; the app swaps it once, at bootstrap).
  if (!getImagePickerPort().available) {
    return (
      <Screen>
        <Title>Foto de la mascota</Title>
        <Callout tone="neutral" title="Todavía no se puede subir una foto desde la app">
          <Body>
            En esta versión la foto se carga desde la web: entrá a Mis mascotas, abrí la mascota y
            tocá Editar. La credencial la va a mostrar acá apenas la subas.
          </Body>
        </Callout>
      </Screen>
    );
  }

  if (state.phase === "done") {
    return (
      <Screen>
        <Title>Foto actualizada</Title>
        <Callout tone="ok" title="La credencial ya muestra la foto nueva">
          <Body>
            {state.photo.replacedPrevious
              ? "Reemplaza a la que estaba. La vas a ver en la credencial y en tu lista de mascotas."
              : "La vas a ver en la credencial y en tu lista de mascotas."}
          </Body>
        </Callout>
        <Image
          source={{ uri: state.photo.photoUrl }}
          style={styles.preview}
          resizeMode="cover"
          accessibilityRole="image"
          accessibilityLabel="La foto nueva de la mascota"
        />
        <PrimaryButton label="Listo" onPress={() => router.back()} />
      </Screen>
    );
  }

  if (state.phase === "review" || state.phase === "uploading") {
    const uploading = state.phase === "uploading";
    return (
      <Screen>
        <Title>¿Usar esta foto?</Title>
        {state.image.previewUri === null ? (
          // An adapter may offer no preview URI. The upload still works; the
          // box says what is missing instead of drawing a broken image.
          <View style={[styles.preview, styles.previewEmpty]}>
            <Text style={styles.previewEmptyText}>Sin vista previa</Text>
          </View>
        ) : (
          <Image
            source={{ uri: state.image.previewUri }}
            style={styles.preview}
            resizeMode="cover"
            accessibilityRole="image"
            accessibilityLabel="Vista previa de la mascota"
          />
        )}

        {!uploading && state.error !== null ? (
          <Callout tone="err">
            <Body>{state.error}</Body>
          </Callout>
        ) : null}

        <PrimaryButton
          label={uploading ? petPhotoStepLabel(state.step) : "Usar esta foto"}
          disabled={uploading}
          onPress={() => void upload(state.image)}
        />
        <SecondaryButton label="Elegir otra" disabled={uploading} onPress={() => void pick()} />
      </Screen>
    );
  }

  const picking = state.phase === "picking";
  return (
    <Screen>
      <Title>Foto de la mascota</Title>
      <Subtitle>
        Es la imagen de la credencial: la ve cualquiera que escanee el QR. Elegí una donde se
        reconozca al animal.
      </Subtitle>

      {state.phase === "choosing" && state.error !== null ? (
        <Callout tone="err">
          <Body>{state.error}</Body>
        </Callout>
      ) : null}

      <PrimaryButton
        label={picking ? "Abriendo tus fotos…" : "Elegir una foto"}
        disabled={picking}
        onPress={() => void pick()}
      />
      {/* The web's own format line, with the third type the bucket accepts. */}
      <Body>JPG, PNG o WebP, hasta 5 MB.</Body>
    </Screen>
  );
}

const styles = StyleSheet.create({
  // The web's preview is 72px inside a form row; here the photo IS the page,
  // so it takes the credential's own aspect: a square, like `.ln-photo`.
  preview: {
    width: "100%",
    aspectRatio: 1,
    borderRadius: RADIUS.control,
    backgroundColor: COLORS.stripe,
  },
  previewEmpty: { alignItems: "center", justifyContent: "center" },
  previewEmptyText: { fontSize: TYPE.md, color: COLORS.inkMuted, padding: SPACE.lg },
});
