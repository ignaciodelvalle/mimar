// The evidence photo block — pick → stage → list, with its own failure and retry.
//
// LIFTED OUT OF `DenunciaScreen` WHEN A SECOND FORM NEEDED IT (D6, the claim
// dispute), so the two forms share one implementation of the same act: the
// picker port, the pet photo's acceptance rules, and a staged key per photo.
// What differs per form is passed in — who mints the ticket (`stage`), the
// heading and the note — and nothing else.
//
// It reports the staged keys up (`onChange`) and whether an upload is in flight
// (`onBusyChange`), so the send button waits for a photo instead of filing
// without it. The list lives here; a parent that must start over (a filed
// denuncia, a dispute whose photos the server has spent) remounts it with a new
// `key`.

import { useCallback, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";

import { ASYNC_IMAGE_PICK_MARKER_STORE } from "../native/image-pick-marker-store";
import { getImagePickerPort, pickImageSafely } from "../native/image-picker-port";
import { type AcceptedImage, acceptPickedImage } from "../pets/pet-photo-view-model";
import { Body } from "../ui/components";
import { Callout, LinkText, SecondaryButton, Subtitle } from "../ui/kit";
import { COLORS, RADIUS, SPACE, TOUCH_TARGET, TYPE } from "../ui/theme";

import type { StageEvidenceResult, StagedEvidence } from "./evidence-flow";

/**
 * The block's own state. `failed` KEEPS the picked image, so "Reintentar"
 * re-uploads the same photo instead of making the person find it again.
 */
type EvidenceState =
  | { name: "idle"; message: string | null }
  | { name: "uploading" }
  | { name: "failed"; message: string; image: AcceptedImage };

export function EvidencePhotos({
  title,
  note,
  maxFiles,
  stage,
  disabled,
  onChange,
  onBusyChange,
}: {
  title: string;
  note: string;
  maxFiles: number;
  /** Mint a ticket on the caller's door and PUT the photo to it. */
  stage: (image: AcceptedImage) => Promise<StageEvidenceResult>;
  disabled: boolean;
  onChange: (evidence: string[]) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [photos, setPhotos] = useState<StagedEvidence[]>([]);
  const [evidenceState, setEvidenceState] = useState<EvidenceState>({
    name: "idle",
    message: null,
  });

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
      const staged = await stage(image);
      onBusyChange(false);
      if (staged.outcome === "failed") {
        setEvidenceState({ name: "failed", message: staged.message, image });
        return;
      }
      setPhotoList([...photos, staged.evidence]);
      setEvidenceState({ name: "idle", message: null });
    },
    [onBusyChange, photos, setPhotoList, stage],
  );

  const addPhoto = useCallback(async () => {
    // NO RECOVERY MARKER (`null`): the pet-photo and tattoo screens can resume a
    // pick an Android process death interrupted, and these forms do not try —
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
      <Subtitle>{title}</Subtitle>
      <Body>{note}</Body>

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
        photos.length < maxFiles ? (
          <SecondaryButton
            label={evidenceState.name === "uploading" ? "Subiendo la foto…" : "Agregar una foto"}
            disabled={disabled || evidenceState.name === "uploading"}
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
  photoRow: { flexDirection: "row", alignItems: "center", gap: SPACE.md },
  photoThumb: { width: TOUCH_TARGET, height: TOUCH_TARGET, borderRadius: RADIUS.control },
  photoLabel: { flex: 1, fontSize: TYPE.sm, color: COLORS.ink },
});
