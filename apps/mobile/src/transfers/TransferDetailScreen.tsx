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

import { apiFailureMessage } from "../api/client";
import { fetchMyTransfers, sendTransferCommand } from "../api/endpoints";
import { KEEP_DESTINATION_ON_SIGN_OUT } from "../auth/return-to";
import { sessionPort, signOut } from "../auth/session-store";
import { Body, Row } from "../ui/components";
import {
  Callout,
  Eyebrow,
  ListRow,
  PrimaryButton,
  Screen,
  SecondaryButton,
  Subtitle,
  TextField,
  Title,
} from "../ui/kit";
import { ListSkeleton } from "../ui/skeleton";
import { COLORS, SPACE } from "../ui/theme";

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

/** Which answer is being confirmed, if any. Two taps for every one of them. */
type Pane = "idle" | "accept" | "reject" | "cancel";

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
  const [pane, setPane] = useState<Pane>("idle");
  const [rejectReason, setRejectReason] = useState("");

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    const result = await fetchMyTransfers(sessionPort);
    if (result.outcome !== "ok") {
      setState({
        phase: "failed",
        message: apiFailureMessage(result) ?? "No pudimos leer esta propuesta.",
      });
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
      setPane("idle");
      if (result.outcome !== "ok") {
        setNotice({
          tone: "err",
          message: apiFailureMessage(result) ?? "No pudimos leer esta propuesta.",
        });
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

  if (state.phase === "loading") {
    return (
      <Screen>
        <Title>Transferencia</Title>
        <ListSkeleton rows={2} label="Cargando la propuesta…" />
      </Screen>
    );
  }

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Transferencia</Title>
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <PrimaryButton label="Reintentar" onPress={() => void load()} />
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
        <Callout tone="neutral">
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
        </Callout>
        {/* NO PRIMARY HERE, on purpose: the arm cannot tell which of its two
            causes is the reader's, so neither way out is "the" next step. Both
            are rows of equal weight. */}
        <ListRow
          label="Reintentar"
          caption="Volver a leer tus transferencias."
          onPress={() => void load()}
        />
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
        <ListRow
          label="Entrar con otra cuenta"
          caption="Si te la enviaron a otro correo tuyo."
          onPress={() => void signOut(KEEP_DESTINATION_ON_SIGN_OUT)}
        />
      </Screen>
    );
  }

  const transfer = state.transfer;

  return (
    <Screen keyboardAvoiding>
      <View style={styles.header}>
        <Title>{transferHeadline(transfer)}</Title>
        <Subtitle>{transferStatusLabel(transfer.status)}</Subtitle>
      </View>

      {notice !== null && (
        <Callout tone={notice.tone}>
          <Body>{notice.message}</Body>
        </Callout>
      )}

      {/* THE FACTS FIRST, then the answer: a decision button shows what is
          being decided beside it (PO rule, custody polish review). */}
      <TransferFacts transfer={transfer} />

      <TransferActions
        transfer={transfer}
        busy={busy}
        pane={pane}
        onPane={setPane}
        rejectReason={rejectReason}
        onRejectReason={setRejectReason}
        onRun={runBuilt}
      />

    </Screen>
  );
}

/**
 * The answer, ONE PANE AT A TIME. While a confirmation (or the reject form) is
 * open it is the only action on screen, so there is never more than one
 * primary button: the old layout could show "Sí, aceptar" and "Confirmar el
 * rechazo" stacked together. Every pane has its own way back, which restores
 * the rows.
 *
 * EVERY CONTROL IS GATED ON A SERVER FLAG, never on `status`. The three are
 * independent: an expired proposal can still be rejected but not accepted, and
 * only the SENDER may cancel.
 *
 * ONE PRIMARY (custody polish, 2026-10-07): the person arrives from a
 * notification to answer, and the one thing they most likely came to do is the
 * primary — accepting, on an incoming proposal. Rejecting and withdrawing are
 * rows: reachable, and not competing with it. The facts sit ABOVE all of it,
 * and the ones the decision turns on are repeated inside the confirmation.
 */
function TransferActions({
  transfer,
  busy,
  pane,
  onPane,
  rejectReason,
  onRejectReason,
  onRun,
}: {
  transfer: MyTransferV1;
  busy: boolean;
  pane: Pane;
  onPane: (pane: Pane) => void;
  rejectReason: string;
  onRejectReason: (value: string) => void;
  onRun: (built: CommandResult) => void;
}) {
  const { canAccept, canReject, canCancel } = transfer.capabilities;

  if (pane === "accept" && canAccept) {
    return (
      <Callout tone="warn" title="¿Aceptás la titularidad?">
        <DecisionFacts transfer={transfer} />
        <Body>
          Al aceptar, {transfer.pet.name} pasa a tu nombre. Es definitivo: no se puede deshacer.
        </Body>
        <PrimaryButton
          label={busy ? "Aceptando…" : "Sí, aceptar la titularidad"}
          disabled={busy}
          onPress={() => onRun(buildAcceptTransfer(transfer.transferToken))}
        />
        <SecondaryButton label="No, volver" disabled={busy} onPress={() => onPane("idle")} />
      </Callout>
    );
  }

  if (pane === "reject" && canReject) {
    return (
      <Callout tone="neutral" title="¿Rechazás la propuesta?">
        <TextField
          accessibilityLabel="Motivo del rechazo"
          editable={!busy}
          label="Motivo (opcional)"
          maxLength={TRANSFER_NOTE_MAX}
          onChangeText={onRejectReason}
          value={rejectReason}
        />
        <PrimaryButton
          tone="seal"
          label={busy ? "Rechazando…" : "Confirmar el rechazo"}
          disabled={busy}
          onPress={() => onRun(buildRejectTransfer(transfer.transferToken, rejectReason))}
        />
        <SecondaryButton label="Volver" disabled={busy} onPress={() => onPane("idle")} />
      </Callout>
    );
  }

  // WITHDRAWING TAKES TWO TAPS TOO (A4-R-02). It is irreversible in the same way
  // accepting is — the proposal is cancelled for good and the recipient is
  // notified — and it sat one thumb-slip away while scrolling to read the
  // deadline. The web gates the same act behind "Confirmar cancelación"
  // (`AcceptTransferActions.tsx:165-211`); this screen already owns the
  // confirm-callout pattern for accept, so it is the same shape twice.
  if (pane === "cancel" && canCancel) {
    return (
      <Callout tone="warn" title="¿Retirás la propuesta?">
        <Body>Si después querés transferir de nuevo tenés que iniciar otra propuesta.</Body>
        <PrimaryButton
          tone="seal"
          label={busy ? "Cancelando…" : "Confirmar cancelación"}
          disabled={busy}
          onPress={() => onRun(buildCancelTransfer(transfer.transferToken))}
        />
        <SecondaryButton label="Atrás" disabled={busy} onPress={() => onPane("idle")} />
      </Callout>
    );
  }

  // The rows are inert (no `onPress`) while a command is in flight, which is
  // how `ListRow` draws and announces a disabled row.
  const open = (next: Pane) => (busy ? undefined : () => onPane(next));
  return (
    <>
      {canAccept ? (
        <PrimaryButton
          label="Aceptar la titularidad"
          disabled={busy}
          onPress={() => onPane("accept")}
        />
      ) : null}
      {canReject ? (
        <ListRow
          label="Rechazar la propuesta"
          caption="Podés contar por qué. Le avisamos a quien te la envió."
          onPress={open("reject")}
        />
      ) : null}
      {canCancel ? (
        <ListRow
          label="Retirar la propuesta"
          caption="Retirarla la cancela para siempre. Podés enviar una nueva después."
          onPress={open("cancel")}
        />
      ) : null}
    </>
  );
}

/**
 * What the irreversible tap is about, INSIDE the confirmation that commits it:
 * who sends the animal, why, and until when the offer stands.
 */
function DecisionFacts({ transfer }: { transfer: MyTransferV1 }) {
  const counterparty = transferCounterpartyLabel(transfer);
  const reason = transferReasonLabel(transfer);
  const deadline = transferDeadlineLabel(transfer);
  return (
    <>
      {counterparty !== null && <Body>{counterparty}</Body>}
      {reason !== null && <Row label="Motivo" value={reason} />}
      {deadline !== null && <Row label="Vencimiento" value={deadline} />}
    </>
  );
}

/** The detail, as label/value lines above the answer. */
function TransferFacts({ transfer }: { transfer: MyTransferV1 }) {
  const counterparty = transferCounterpartyLabel(transfer);
  const reason = transferReasonLabel(transfer);
  const deadline = transferDeadlineLabel(transfer);
  return (
    <View style={styles.section}>
      <Eyebrow>Detalle de la transferencia</Eyebrow>
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
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: SPACE.xs },
  // The detail, as a sheet of label/value lines rather than a titled Card,
  // ruled off from the answer under it.
  section: {
    gap: SPACE.sm,
    paddingBottom: SPACE.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
});
