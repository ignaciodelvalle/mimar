// INICIAR UNA DISPUTA — the claim wizard's third step, in the app (D6).
//
// Its own component so `ClaimScreen` stays the wizard and this stays the form:
// an explanation with a live count and one to five evidence photos, sent to the
// SAME use-case the web's `submitClaimDisputeAction` runs. It owns its draft;
// the identifier comes from the screen, which is the only place it lives.
//
// THE SEND IS DISABLED UNTIL BOTH HALVES ARE THERE — a reason the server will
// accept (counted trimmed, the way it counts) and at least one staged photo —
// because the server's evidence gate is absolute and a form that let the
// person tap into a certain refusal would be a form that wastes their photos:
// each staged photo is used once, and a refused dispute has spent them.

import { useCallback, useMemo, useState } from "react";
import { StyleSheet, Text } from "react-native";

import type { PetClaimLookupAckV1 } from "@dim/contract/api";
import type { PetClaimIdentifierKind } from "@dim/contract/input";
import { CLAIM_EVIDENCE_MAX_FILES } from "@dim/contract/input";

import { apiFailureMessage } from "../api/client";
import { sendPetClaimCommand } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { EvidencePhotos } from "../denuncias/EvidencePhotos";
import type { AcceptedImage } from "../pets/pet-photo-view-model";
import { Body } from "../ui/components";
import { Callout, PrimaryButton, Screen, SecondaryButton, TextField, Title } from "../ui/kit";
import { COLORS, SPACE, TYPE } from "../ui/theme";
import { useDraftDiscardGuard } from "../ui/use-draft-discard-guard";

import {
  DISPUTE_EVIDENCE_NOTE,
  DISPUTE_INTRO,
  DISPUTE_PHOTOS_SPENT,
  buildDisputeCommand,
  claimInputMessage,
  disputeReasonCount,
  disputeSentBody,
} from "./claim-view-model";
import { stageDisputePhoto } from "./dispute-evidence";

const SEND_FAILED = "No pudimos enviar la disputa.";

export function DisputeForm({
  kind,
  value,
  ack,
  onCancel,
  onDisputed,
}: {
  kind: PetClaimIdentifierKind;
  /** The identifier the lookup ran on — re-sent, never a handle the lookup issued. */
  value: string;
  ack: PetClaimLookupAckV1;
  onCancel: () => void;
  onDisputed: (disputeToken: string) => void;
}) {
  const [reason, setReason] = useState("");
  // The photo list lives in `EvidencePhotos`; the keys it reports land here,
  // and `photoEpoch` remounts it empty when the server has spent them.
  const [evidence, setEvidence] = useState<string[]>([]);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoEpoch, setPhotoEpoch] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ message: string; photosSpent: boolean } | null>(null);

  // THE BACK GESTURE MAY NOT DISCARD A WRITTEN DISPUTE — the explanation is the
  // longest thing the claim flow asks for, and the photos cost uploads.
  useDraftDiscardGuard(reason.trim() !== "" || evidence.length > 0);

  const stageEvidence = useCallback(
    (image: AcceptedImage) => stageDisputePhoto(sessionPort, image),
    [],
  );
  const reasonCount = useMemo(() => disputeReasonCount(reason), [reason]);

  const send = useCallback(async () => {
    const draft = buildDisputeCommand(kind, value, reason, evidence);
    if (!draft.ok) {
      setError({ message: claimInputMessage(draft.code), photosSpent: false });
      return;
    }
    setSending(true);
    setError(null);
    const result = await sendPetClaimCommand(sessionPort, draft.input);
    setSending(false);
    if (result.outcome === "ok" && result.payload.command === "dispute") {
      onDisputed(result.payload.disputeToken);
      return;
    }
    // EVERY FAILED SEND STARTS THE PHOTOS OVER. The server claims each staged
    // photo before it runs the dispute and discards it on any refusal, so a
    // re-send with the same keys can only be refused again. The explanation
    // stays: it is the person's own text and nothing spent it.
    const message =
      result.outcome === "ok" ? SEND_FAILED : (apiFailureMessage(result) ?? SEND_FAILED);
    setEvidence([]);
    setPhotoEpoch((epoch) => epoch + 1);
    setError({ message, photosSpent: true });
  }, [evidence, kind, onDisputed, reason, value]);

  const canSend =
    !sending &&
    !uploadingPhoto &&
    reasonCount.enough &&
    !reasonCount.tooLong &&
    evidence.length > 0;

  return (
    <Screen>
      <Title>{`Iniciar una disputa por ${ack.petName ?? "la mascota"}`}</Title>
      <Body>{DISPUTE_INTRO}</Body>

      <TextField
        label="¿Por qué creés que es tuya?"
        required
        multiline
        numberOfLines={5}
        editable={!sending}
        value={reason}
        onChangeText={setReason}
        placeholder="Contá desde cuándo es tuya, cómo la perdiste y qué prueba tenés."
      />
      <Text
        style={[styles.count, reasonCount.tooLong ? styles.countOver : null]}
        accessibilityLiveRegion="polite"
      >
        {reasonCount.label}
      </Text>

      <EvidencePhotos
        key={photoEpoch}
        title={`Fotos (al menos 1, hasta ${CLAIM_EVIDENCE_MAX_FILES})`}
        note={DISPUTE_EVIDENCE_NOTE}
        maxFiles={CLAIM_EVIDENCE_MAX_FILES}
        stage={stageEvidence}
        disabled={sending}
        onChange={setEvidence}
        onBusyChange={setUploadingPhoto}
      />

      {error === null ? null : (
        <Callout tone="err">
          <Body>{error.message}</Body>
          {error.photosSpent ? <Body>{DISPUTE_PHOTOS_SPENT}</Body> : null}
        </Callout>
      )}

      <PrimaryButton
        label={sending ? "Enviando…" : "Enviar la disputa"}
        disabled={!canSend}
        onPress={() => void send()}
      />
      <SecondaryButton label="Cancelar" disabled={sending} onPress={onCancel} />
    </Screen>
  );
}

/** The receipt, with the web's "Referencia" — selectable, so it can be copied or read out. */
export function DisputeSent({ petName, disputeToken }: { petName: string; disputeToken: string }) {
  return (
    <Screen>
      <Title>Reclamo enviado</Title>
      <Callout tone="ok">
        <Body>{disputeSentBody(petName)}</Body>
      </Callout>
      <Text selectable style={styles.reference}>
        {`Referencia: ${disputeToken}`}
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  count: { fontSize: TYPE.sm, color: COLORS.inkSoft, marginBottom: SPACE.sm },
  countOver: { color: COLORS.danger },
  reference: { fontSize: TYPE.sm, color: COLORS.ink, marginTop: SPACE.sm },
});
