// One transfer proposal, and the answer to it.
//
// THE DEEP-LINK DESTINATION. `mimar://transferencias/{PTR-…}` lands here, and so
// does the notification the sender's action queued (`ctaUrl:
// /transferencias/{token}`). It is therefore the one screen in this app that a
// person can reach without having navigated to it, which changes two things:
//
//   · IT READS THE HUB, not a per-token endpoint. The union of the three lists
//     `/me/transfers` returns is exactly the set this caller is authorized to
//     see — the server built them with the same addressee rule the accept writer
//     runs — so a token that is not in it is one this person may not read. That
//     is a fact the screen can state without a second round trip, and without
//     the server having to answer a question that would tell a stranger whether
//     a token is real.
//   · IT CANNOT ASSUME A PET. The person answering may hold no animal at all;
//     this may be their first. Nothing here reads `publicToken` from anywhere
//     but the proposal itself.
//
// ACCEPTING IS IRREVERSIBLE AND THE CONTROL SAYS SO — TWICE.
// ---------------------------------------------------------------------------
// Ownership changes hands, a `custody_transferred` asiento is appended to an
// append-only spine, and any live caretaker arrangement ends. There is no undo
// and the app must not imply one. The web reached the same conclusion by audit
// (`AcceptTransferActions.tsx:34-38`): accept used to fire on a single tap while
// REJECT asked for a reason and a second tap — backwards — and it now takes two.
// This screen takes two for the same reason.
//
// NO IDEMPOTENCY KEY, AND THE REFLEX IS RIGHT BUT THE ANSWER IS NO. A spine
// write travels here, so every other write in this app would carry one. This
// endpoint does not read the header, because `acceptPetTransfer` takes no
// `clientIdempotencyKey`; what it has instead is an `expectedStatus: "pending"`
// UPDATE, which REFUSES a replay rather than absorbing it. So the failure the
// header exists for — a timeout on a request that in fact committed — comes back
// as `transfer_already_resolved`, and the only correct response to it is to
// RE-READ. That is what this screen does on every failure, and why its error copy
// says "actualizá" rather than "volvé a intentar".

import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import type { MyTransferV1, MyTransfersV1, TransferCommandAckV1 } from "@dim/contract/api";
import { TRANSFER_NOTE_MAX } from "@dim/contract/input";
import type { TransferCommandInput } from "@dim/contract/input";

import type { ApiResult } from "../api/client";
import { fetchMyTransfers, sendTransferCommand } from "../api/endpoints";
import { apiErrorMessage } from "../api/error-copy";
import { KEEP_DESTINATION_ON_SIGN_OUT } from "../auth/return-to";
import { sessionPort, signOut } from "../auth/session-store";
import { Body, Card, Loading, Row } from "../ui/components";
import { Callout, PrimaryButton, Screen, SecondaryButton, TextField, Title } from "../ui/kit";
import { SPACE } from "../ui/theme";

import {
  type CommandResult,
  buildAcceptTransfer,
  buildCancelTransfer,
  buildRejectTransfer,
  findTransfer,
  transferCounterpartyLabel,
  transferDeadlineLabel,
  transferHeadline,
  transferReasonLabel,
  transferStatusLabel,
} from "./transfers-view-model";

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
      return "No pudimos leer esta propuesta.";
  }
}

/** One sentence per command, for the line above the card. */
function ackLabel(ack: TransferCommandAckV1): string {
  switch (ack.command) {
    case "accept":
      return "Listo. La mascota ahora es tuya.";
    case "reject":
      return "Rechazaste la propuesta. Le avisamos a quien te la envió.";
    case "cancel":
      return "Retiraste la propuesta.";
    case "initiate":
      // Not reachable from this screen — it answers an EXISTING proposal — but
      // the switch is exhaustive over the contract's union on purpose, so a new
      // command is a compile error here rather than a blank line on a phone.
      return "Propuesta enviada.";
  }
}

type ScreenState =
  | { phase: "loading" }
  | { phase: "ready"; transfer: MyTransferV1 }
  | { phase: "missing" }
  | { phase: "failed"; message: string };

type Notice = { tone: "ok" | "err"; message: string } | null;

export function TransferDetailScreen({
  transferToken,
  onAccepted,
}: {
  transferToken: string;
  /** Where to go once the animal is this person's. Given the new pet's token. */
  onAccepted: (petPublicToken: string | null) => void;
}) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingAccept, setConfirmingAccept] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    const result = await fetchMyTransfers(sessionPort);
    if (result.outcome !== "ok") {
      setState({ phase: "failed", message: failureMessage(result) });
      return;
    }
    const found = findTransfer(result.payload as MyTransfersV1, transferToken);
    setState(found === null ? { phase: "missing" } : { phase: "ready", transfer: found });
  }, [transferToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (input: TransferCommandInput) => {
      setBusy(true);
      setNotice(null);
      const result = await sendTransferCommand(sessionPort, input);
      setBusy(false);
      setConfirmingAccept(false);
      setConfirmingCancel(false);
      setRejecting(false);
      if (result.outcome !== "ok") {
        setNotice({ tone: "err", message: failureMessage(result) });
        // RE-READ ON FAILURE, ALWAYS. Without an idempotency key, a refusal
        // after a timeout may mean the first attempt landed. The list is the
        // only thing that can say which.
        await load();
        return;
      }
      setNotice({ tone: "ok", message: ackLabel(result.payload) });
      if (result.payload.command === "accept") {
        onAccepted(result.payload.petPublicToken);
        return;
      }
      await load();
    },
    [load, onAccepted],
  );

  // THE CONTRACT-VALIDATING BUILDER, not a hand-built command literal
  // (A11-G2). `buildAcceptTransfer`/`buildRejectTransfer`/`buildCancelTransfer`
  // run the same `transferCommandInputSchema.safeParse` every OTHER caller of
  // `sendTransferCommand` in this app goes through — `TransferInitiateScreen`'s
  // `submit` is the pattern this mirrors — so a runtime-only refinement added to
  // the schema later (`optionalNote` in `packages/contract/src/input/
  // transfer.ts`) is caught here too, instead of only on the initiate screen.
  const runBuilt = useCallback(
    (built: CommandResult) => {
      if (!built.ok) {
        setNotice({ tone: "err", message: built.message });
        return;
      }
      void run(built.input);
    },
    [run],
  );

  if (state.phase === "loading") return <Loading label="Cargando la propuesta…" />;

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Transferencia</Title>
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load()} />
      </Screen>
    );
  }

  if (state.phase === "missing") {
    // NOT "no existe". This caller may simply not be a party to it, and the two
    // are deliberately indistinguishable from here: the screen never learned who
    // the addressee is, and saying "no existe" about a real proposal would be a
    // lie told with confidence.
    return (
      <Screen>
        <Title>Transferencia</Title>
        <Card>
          <Body>
            No encontramos esta propuesta en tu cuenta. Puede que ya no esté disponible o que no sea
            para vos.
          </Body>
          {/* THE REMEDY, WHICH THE WEB GIVES AND THIS SCREEN DID NOT (A4-custodia-11).
              A person with two addresses opening the link on the wrong account read
              "no sea para vos" and a "Reintentar" that can only produce the same
              screen — the one refusal in this app where retrying is guaranteed to
              be useless. `/cuidado/[grantToken]/page.tsx:86-89` says what to do.

              BOTH CAUSES GET A SENTENCE, AND THE REMEDY IS ATTACHED TO ONE OF
              THEM (finding F9, review 2026-09-07). The first draft prescribed
              the account switch on EVERY `missing`, which covers a proposal that
              simply resolved — accepted, cancelled, expired — far more often
              than a wrong session. "Cerrá sesión y volvé a entrar con esa
              cuenta" is a remedy for nothing in that case, and it sends somebody
              out of their working account to look for a proposal that no longer
              exists on any of them. The WEB may state the wrong-account theory
              flatly because it KNOWS: `relation === "outsider"` is a fact its
              reader resolved. This screen never learned who the addressee is, so
              it names two possibilities and lets the reader pick the one that is
              theirs. */}
          <Body>
            Si ya la aceptaron, la cancelaron o venció, no vas a poder verla acá y no hay nada que
            hacer.
          </Body>
          <Body>
            Si en cambio tenés otra cuenta, puede que se la hayan enviado a ese correo: entrá con
            esa cuenta, o pedile a quien te la envió que la reenvíe a este correo.
          </Body>
        </Card>
        <SecondaryButton label="Reintentar" onPress={() => void load()} />
        {/* THE LABEL NAMES THE CASE IT BELONGS TO, which is what lets it be
            offered unconditionally on an arm the screen cannot disambiguate
            (finding F9). "Cerrar sesión" beside "puede que no sea para vos"
            reads as this app's instruction to the person in front of it; "Entrar
            con otra cuenta" is a door for the reader who already knows they have
            a second address, and says nothing to the one whose proposal expired.

            NOT `signOut(pathname)`. The gate suppresses `next` for the screen a
            person deliberately closed (`signedOutHref`), and this is the one
            sign-out whose whole purpose is to come BACK here with the other
            account — see `KEEP_DESTINATION_ON_SIGN_OUT`. */}
        <SecondaryButton
          label="Entrar con otra cuenta"
          onPress={() => void signOut(KEEP_DESTINATION_ON_SIGN_OUT)}
        />
      </Screen>
    );
  }

  const transfer = state.transfer;
  const counterparty = transferCounterpartyLabel(transfer);
  const reason = transferReasonLabel(transfer);
  const deadline = transferDeadlineLabel(transfer);
  const { canAccept, canReject, canCancel } = transfer.capabilities;

  return (
    <Screen keyboardAvoiding>
      <Title>{transferHeadline(transfer)}</Title>
      <Body>{transferStatusLabel(transfer.status)}</Body>

      {notice !== null && (
        <Callout tone={notice.tone}>
          <Body>{notice.message}</Body>
        </Callout>
      )}

      <Card title="Detalle de la transferencia">
        {counterparty !== null && <Body>{counterparty}</Body>}
        {reason !== null && <Row label="Motivo" value={reason} />}
        {transfer.note !== null && <Row label="Comentario" value={transfer.note} />}
        {/* Only while there IS one. The status line under the title already says
            how an answered proposal ended. */}
        {deadline !== null && <Row label="Vencimiento" value={deadline} />}
        {/* OUTGOING ONLY (A4-R-04). On an incoming proposal `toEmail` is the
            READER'S OWN address, and the view-model's header already calls that
            noise: "Recibiste a Firu" followed by a row labelled "Email del
            receptor" carrying the address of the person holding the phone. On an
            outgoing one it is the only place the address appears when the
            recipient has a display name. */}
        {transfer.direction === "outgoing" && (
          <Row label="Email del receptor" value={transfer.toEmail} />
        )}
        {transfer.rejectionReason !== null && (
          <Row label="Motivo del rechazo" value={transfer.rejectionReason} />
        )}
      </Card>

      {/* EVERY CONTROL IS GATED ON A SERVER FLAG, never on `status`. The three
          are independent: an expired proposal can still be rejected but not
          accepted, and only the SENDER may cancel. */}
      {canAccept && (
        <View style={styles.actions}>
          {confirmingAccept ? (
            <Callout tone="warn">
              <Body>
                Al aceptar, {transfer.pet.name} pasa a tu nombre. Es definitivo: no se puede
                deshacer.
              </Body>
              <PrimaryButton
                label={busy ? "Aceptando…" : "Sí, aceptar la titularidad"}
                disabled={busy}
                onPress={() => runBuilt(buildAcceptTransfer(transfer.transferToken))}
              />
              <SecondaryButton
                label="No, volver"
                disabled={busy}
                onPress={() => setConfirmingAccept(false)}
              />
            </Callout>
          ) : (
            <PrimaryButton
              label="Aceptar la titularidad"
              disabled={busy}
              onPress={() => setConfirmingAccept(true)}
            />
          )}
        </View>
      )}

      {canReject && (
        <View style={styles.actions}>
          {rejecting ? (
            <>
              <TextField
                accessibilityLabel="Motivo del rechazo"
                editable={!busy}
                label="Motivo (opcional)"
                maxLength={TRANSFER_NOTE_MAX}
                onChangeText={setRejectReason}
                value={rejectReason}
              />
              <PrimaryButton
                label={busy ? "Rechazando…" : "Confirmar el rechazo"}
                disabled={busy}
                onPress={() => runBuilt(buildRejectTransfer(transfer.transferToken, rejectReason))}
              />
              <SecondaryButton label="Volver" disabled={busy} onPress={() => setRejecting(false)} />
            </>
          ) : (
            <SecondaryButton
              label="Rechazar la propuesta"
              disabled={busy}
              onPress={() => setRejecting(true)}
            />
          )}
        </View>
      )}

      {/* WITHDRAWING TAKES TWO TAPS TOO (A4-R-02). It is irreversible in the same
          way accepting is — the proposal is cancelled for good and the recipient
          is notified — and it sat one thumb-slip away while scrolling to read the
          deadline. The web gates the same act behind "Confirmar cancelación"
          (`AcceptTransferActions.tsx:165-211`); this screen already owns the
          confirm-callout pattern for accept, so it is the same shape twice. */}
      {canCancel && (
        <View style={styles.actions}>
          {confirmingCancel ? (
            <Callout tone="warn">
              <Body>Si después querés transferir de nuevo tenés que iniciar otra propuesta.</Body>
              <PrimaryButton
                tone="seal"
                label={busy ? "Cancelando…" : "Confirmar cancelación"}
                disabled={busy}
                onPress={() => runBuilt(buildCancelTransfer(transfer.transferToken))}
              />
              <SecondaryButton
                label="Atrás"
                disabled={busy}
                onPress={() => setConfirmingCancel(false)}
              />
            </Callout>
          ) : (
            <>
              <SecondaryButton
                label="Retirar la propuesta"
                disabled={busy}
                onPress={() => setConfirmingCancel(true)}
              />
              <Body>Retirarla la cancela para siempre. Podés enviar una nueva después.</Body>
            </>
          )}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { gap: SPACE.sm, marginTop: SPACE.md },
});
