// Ofrecer la titularidad — the form that starts a transfer.
//
// THE ONE PET-ADDRESSED COMMAND of the four, which is why this is a screen under
// an animal while the other three live on the hub. Its rule is also the narrowest
// on this surface: the caller must hold the ACTIVE `role='owner'` ownership row
// (`initiate-pet-transfer.ts:101-105`). A co-owner passes `requireTitularAccess`
// everywhere else in this app and is refused here — so the screen does NOT
// pre-judge, it asks, and it renders `transfer_forbidden` when the server says
// no. There is no capability flag to read: the pet payload does not carry one,
// and inventing a local guess ("am I the owner?") would be a second copy of a
// rule that lives in one place.
//
// NO IDEMPOTENCY KEY, LIKE THE OTHER THREE, and here the protection is a partial
// unique index (`pet_transfers_one_pending_per_pet`) rather than a status guard.
// A double submit does not create a second proposal — it is REFUSED as
// `transfer_pending_exists`, which is a safe outcome and an honest one: the
// person is told there is already one in flight and where to go to withdraw it.
//
// THE ADDRESS IS NOT CHECKED FOR EXISTENCE, and must not be. Answering "esa
// cuenta no existe" would turn this form into an oracle over the user table. The
// server resolves the address to an account when it can and sends an invitation
// when it cannot, and it reports WHICH in the ack — `recipientNeedsInvite` — so
// this screen can tell the person what kind of wait they are in for instead of
// leaving them refreshing a list that will never change.

import { useCallback, useState } from "react";
import { View } from "react-native";

import type { OwnerTransferReason, TransferCommandInputCode } from "@dim/contract/input";
import { TRANSFER_NOTE_MAX } from "@dim/contract/input";

import type { ApiResult } from "../api/client";
import { sendTransferCommand } from "../api/endpoints";
import { apiErrorMessage } from "../api/error-copy";
import { sessionPort } from "../auth/session-store";
import { Body, Card } from "../ui/components";
import { Callout, Choice, PrimaryButton, Screen, TextField, Title } from "../ui/kit";
import { useDraftDiscardGuard } from "../ui/use-draft-discard-guard";
import { useScrollToError } from "../ui/use-scroll-to-error";

import {
  TRANSFER_REASON_CHOICES,
  TRANSFER_WINDOW_DAYS,
  buildInitiateTransfer,
  transferInitiateRefusalMessage,
} from "./transfers-view-model";

/** The four values, in the web's order, for the chooser. */
const REASON_VALUES: readonly OwnerTransferReason[] = TRANSFER_REASON_CHOICES.map((c) => c.reason);

function failureMessage(result: ApiResult<unknown>): string {
  switch (result.outcome) {
    case "api-error":
      // The screen's own sentence first, the shared one otherwise. Only
      // `transfer_forbidden` is overridden, and only here — on the DETAIL screen
      // the shared answer-time copy is exactly right.
      return transferInitiateRefusalMessage(result.code) ?? apiErrorMessage(result.code);
    case "unsupported-version":
      return "Esta versión de la app no puede enviar esta propuesta. Actualizá la app.";
    case "malformed":
      return "La respuesta del servidor no se pudo leer.";
    case "unreachable":
      return "No pudimos conectarnos. Revisá tu conexión.";
    default:
      return "No pudimos enviar la propuesta.";
  }
}

type Notice = { tone: "ok" | "err"; message: string } | null;

/**
 * What the sender is told when the address they typed has no account
 * (A4-custodia-01).
 *
 * THE SCREEN USED TO NAVIGATE AWAY ON EVERY SUCCESS, which made the two outcomes
 * of a transfer look identical: one is a proposal sitting in somebody's inbox,
 * the other is a proposal nobody has been told about. The server reports which —
 * `recipientNeedsInvite` — precisely so this can be said, and nothing said it.
 *
 * THE APP SENDS NO INVITATION AND MUST NOT PRETEND IT DOES. The web's flow calls
 * `inviteUserByEmail` with a redirect into a BROWSER session
 * (`src/modules/transfers/actions.ts`), which is why the native write
 * deliberately does not fire it (`app/api/v1/me/transfers/commands.ts`): a magic
 * link would land the recipient on a web page on a phone that has this app
 * installed. So the honest sentence is "avisale vos", and the web's own hint —
 * "Si todavía no tiene cuenta en miMAR, le enviamos un link de signup" — is the
 * WEB's behaviour and would be a lie here.
 */
const NEEDS_INVITE_HEADLINE = "Esa persona todavía no tiene cuenta en miMAR";

export function TransferInitiateScreen({
  publicToken,
  petName,
  onSent,
}: {
  publicToken: string;
  /** For the copy. `null` when the caller reached this screen by deep link. */
  petName: string | null;
  onSent: (transferToken: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState<OwnerTransferReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  // Only a REFUSAL moves the view. A notice with any other tone is news, not a
  // thing to go fix, and yanking the scroll for it is the "jarring focus jump"
  // the web hook this mirrors refuses to make.
  const { anchorRef: errorAnchor, scrollRef } = useScrollToError(
    notice !== null && notice.tone === "err" ? notice.message : null,
  );

  // WHICH field the refusal was about, for the red border (forms-F3: the kit
  // has an `invalid` prop and almost nothing used it). The CODE and not a
  // boolean per field, because the code is what the contract already told us —
  // this invents no validation of its own. Cleared the moment a field is
  // edited, so the box stops being red on the keystroke and not on the retry.
  const [invalidCode, setInvalidCode] = useState<TransferCommandInputCode | null>(null);
  /** The proposal's token, once it landed for an address with NO account. */
  const [sent, setSent] = useState<string | null>(null);
  // THE BACK GESTURE MAY NOT DISCARD A TYPED PROPOSAL (critic gap 2). `sent`
  // clears it: the proposal exists on the server and the screen is an
  // acknowledgement, so there is nothing left for the person to lose.
  //
  // `allowLeave` IS NOT OPTIONAL, and the first draft of this screen dropped it
  // (finding H1, review 2026-09-07). The guard fires on EVERY navigation away,
  // including the one this screen makes itself after the proposal has landed on
  // the server — so a successful transfer asked "¿Salir sin guardar?" and
  // "Seguir editando" stranded the person on a form whose submission had already
  // gone through. Re-sending from there is refused as `transfer_pending_exists`,
  // which is the honest answer to a question nobody should have been asked.
  // `app/alta.tsx` is the precedent: `allowLeave()` immediately before the exit.
  const { allowLeave } = useDraftDiscardGuard(
    sent === null && (email !== "" || reason !== null || note !== ""),
  );

  const submit = useCallback(async () => {
    setNotice(null);
    // The CONTRACT's schema, run locally first, so a bad address gets a field
    // sentence instead of a round trip that answers `invalid_request` with no
    // field detail. Same rule every other form in this app follows.
    const built = buildInitiateTransfer({
      petPublicToken: publicToken,
      toEmail: email,
      reason: reason ?? "",
      note,
    });
    if (!built.ok) {
      setNotice({ tone: "err", message: built.message });
      setInvalidCode(built.code);
      return;
    }
    setInvalidCode(null);

    setBusy(true);
    const result = await sendTransferCommand(sessionPort, built.input);
    setBusy(false);
    if (result.outcome !== "ok") {
      setNotice({ tone: "err", message: failureMessage(result) });
      return;
    }
    if (result.payload.recipientNeedsInvite === true) {
      // NOT a navigation. Leaving for the proposal screen here would show the
      // sender a pending transfer and no hint that the other side has no way to
      // learn about it — the exact wait that never ends.
      setSent(result.payload.transferToken);
      return;
    }
    // The proposal exists. Nothing is left to protect, and the guard may not
    // stand between the person and the screen that shows what they just did.
    allowLeave();
    onSent(result.payload.transferToken);
  }, [allowLeave, email, note, onSent, publicToken, reason]);

  const subject = petName ?? "esta mascota";

  if (sent !== null) {
    return (
      <Screen>
        <Title>Propuesta enviada</Title>
        <Card title={NEEDS_INVITE_HEADLINE}>
          <Body>
            La propuesta de {subject} quedó creada y espera {TRANSFER_WINDOW_DAYS} días. Como ese
            correo todavía no tiene cuenta, desde la app no le llega ningún aviso.
          </Body>
          <Body>
            Avisale vos y pedile que cree una cuenta en miMAR con ese mismo correo: cuando entre, la
            propuesta la está esperando.
          </Body>
        </Card>
        <PrimaryButton label="Ver la propuesta" onPress={() => onSent(sent)} />
      </Screen>
    );
  }

  return (
    <Screen keyboardAvoiding scrollRef={scrollRef}>
      <Title>Transferir {subject}</Title>
      <Body>
        Le pasás la titularidad a otra persona. Recibe una propuesta y tiene {TRANSFER_WINDOW_DAYS}{" "}
        días para aceptarla o rechazarla. Hasta que acepte, no cambia nada.
      </Body>

      {notice !== null && (
        <View ref={errorAnchor}>
          <Callout tone={notice.tone}>
            <Body>{notice.message}</Body>
          </Callout>
        </View>
      )}

      <TextField
        accessibilityLabel="Email del receptor"
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        editable={!busy}
        inputMode="email"
        invalid={invalidCode === "EMAIL_INVALID"}
        label="Email del receptor"
        onChangeText={(value) => {
          setEmail(value);
          setInvalidCode(null);
        }}
        placeholder="receptor@ejemplo.com"
        required
        value={email}
      />

      {/* NOTHING IS PRESELECTED. The web's `<select>` opens on "Regalo", which
          on a form that hands over an animal means the commonest submission is
          a reason nobody chose. Four visible chips with none checked costs one
          tap and removes that. */}
      <Choice
        label="Motivo"
        required
        options={REASON_VALUES}
        selected={reason}
        optionLabel={(value) =>
          TRANSFER_REASON_CHOICES.find((c) => c.reason === value)?.label ?? value
        }
        onSelect={setReason}
        disabled={busy}
      />

      <TextField
        accessibilityLabel="Comentario para el receptor"
        editable={!busy}
        invalid={invalidCode === "NOTE_TOO_LONG"}
        label="Comentario (opcional)"
        maxLength={TRANSFER_NOTE_MAX}
        multiline
        onChangeText={(value) => {
          setNote(value);
          setInvalidCode(null);
        }}
        value={note}
      />

      <PrimaryButton
        label={busy ? "Enviando…" : "Enviar la propuesta"}
        disabled={busy || email.trim().length === 0 || reason === null}
        onPress={() => void submit()}
      />
    </Screen>
  );
}
