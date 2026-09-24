// DEVOLUCIÓN — responder a quien quiere devolverte el animal, o proponer
// devolvérselo a la organización que te lo dio.
//
// EVERY CONTROL COMES FROM `capabilities`, NEVER FROM `state.kind`
// ---------------------------------------------------------------------------
// That is the one rule this screen exists to follow, and it is the one the web's
// own page breaks. `.../devolucion/page.tsx` draws the acceptance card whenever
// a proposal is pending, without checking it is ADDRESSED to the viewer — so an
// owner whose own outgoing proposal is in flight gets an "Aceptar" that
// `ownerAcceptReturnUseCase` refuses with "Esta propuesta no está dirigida a
// vos." The server here answers a separate `capabilities` block precisely so a
// client cannot repeat that, and this screen reads it.
//
// THE STATE IS STILL RENDERED, because a refusal a person cannot see the reason
// for is a screen that reads as broken. `returnStateHeadline` says what is going
// on in every arm — including the three that offer nothing — and the buttons
// appear underneath only where the capability is true.
//
// A LANDED `accept_return` IS NOT ALWAYS "listo". The writer has a success arm
// in which the animal did NOT come back: the proposer lost custody, or the pet
// is no longer `lost`, and it cancels instead of transferring. `acceptedMessage`
// renders the server's own sentence for that case, in the ERROR tone, because a
// green "Listo" over a cancellation would tell somebody their animal is home.
//
// THE READ IS RE-RUN AFTER EVERY WRITE, not patched from the ack. All three
// writes change the state — an accept ends the pending proposal, a propose
// creates one — and the ack carries none of it. A screen that guessed the new
// state would be deriving what the server is here to answer.

import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import type { PetReturnV1 } from "@dim/contract/api";
import { RETURN_NOTES_MAX, RETURN_REJECT_REASON_MAX } from "@dim/contract/input";

import type { ApiResult } from "../api/client";
import { fetchPetReturn, sendPetReturnCommand } from "../api/endpoints";
import { apiErrorMessage } from "../api/error-copy";
import { sessionPort } from "../auth/session-store";
import { Body, Card, Loading } from "../ui/components";
import {
  Callout,
  Choice,
  PrimaryButton,
  Screen,
  SecondaryButton,
  TextField,
  Title,
} from "../ui/kit";

import {
  RETURN_REASON_CHOICES,
  type ReturnCommandResult,
  acceptedMessage,
  buildAcceptReturn,
  buildProposeReturn,
  buildRejectReturn,
  returnStateHeadline,
} from "./devolucion-view-model";

/**
 * One sentence per failure arm. No arm falls through to a generic shrug, and
 * none of them quotes anything the server sent.
 */
function failureMessage(result: ApiResult<unknown>): string {
  switch (result.outcome) {
    case "api-error":
      return apiErrorMessage(result.code);
    case "unsupported-version":
      return "Esta versión de la app no puede abrir esta pantalla. Actualizá la app.";
    case "malformed":
      return "La respuesta del servidor no se pudo leer.";
    case "unreachable":
      return "No pudimos conectarnos. Revisá tu conexión.";
    default:
      return "No pudimos abrir la devolución.";
  }
}

type ScreenState =
  | { phase: "loading" }
  | { phase: "failed"; message: string }
  | { phase: "ready"; view: PetReturnV1 };

type Notice = { tone: "ok" | "err"; message: string } | null;

const REASON_VALUES = RETURN_REASON_CHOICES.map((c) => c.reason);

export function DevolucionScreen({ publicToken }: { publicToken: string }) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [proposeReason, setProposeReason] = useState<string | null>(null);
  const [proposeNotes, setProposeNotes] = useState("");

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    const result = await fetchPetReturn(sessionPort, publicToken);
    if (result.outcome !== "ok") {
      setState({ phase: "failed", message: failureMessage(result) });
      return;
    }
    setState({ phase: "ready", view: result.payload });
  }, [publicToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (built: ReturnCommandResult, petName: string) => {
      setNotice(null);
      if (!built.ok) {
        setNotice({ tone: "err", message: built.message });
        return;
      }
      setBusy(true);
      const result = await sendPetReturnCommand(sessionPort, publicToken, built.input);
      setBusy(false);
      if (result.outcome !== "ok") {
        setNotice({ tone: "err", message: failureMessage(result) });
        // A REFUSAL IS STILL A REASON TO RE-READ. `return_no_proposal` and
        // `return_already_pending` both mean the state moved under this screen,
        // and leaving the old buttons up would invite the same refusal again.
        await load();
        return;
      }
      if (result.payload.command === "accept_return") {
        setNotice(acceptedMessage(result.payload, petName));
      } else if (result.payload.command === "reject_return") {
        setNotice({ tone: "ok", message: "Listo. Le avisamos que no la aceptás." });
      } else {
        setNotice({ tone: "ok", message: "Listo. La organización recibió tu propuesta." });
      }
      setRejectReason("");
      setProposeNotes("");
      setProposeReason(null);
      await load();
    },
    [load, publicToken],
  );

  if (state.phase === "loading") {
    return (
      <Screen>
        <Title>Devolución</Title>
        <Loading label="Cargando…" />
      </Screen>
    );
  }

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Devolución</Title>
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load()} />
      </Screen>
    );
  }

  const view = state.view;
  const { canAccept, canReject, canPropose } = view.capabilities;

  return (
    <Screen keyboardAvoiding>
      <Title>Devolución de {view.petName}</Title>
      <Body>{returnStateHeadline(view.state, view.petName)}</Body>

      {notice !== null && (
        <Callout tone={notice.tone}>
          <Body>{notice.message}</Body>
        </Callout>
      )}

      {view.state.kind === "inbound_pending" && view.state.notes !== null ? (
        <Card title="Lo que dejó escrito">
          <Body>{view.state.notes}</Body>
        </Card>
      ) : null}

      {canAccept ? (
        <Card title="Confirmar la devolución">
          <View style={{ gap: 12 }}>
            <Body>
              Confirmá sólo cuando tengas a {view.petName} con vos. La custodia de quien la tiene se
              cierra en ese momento.
            </Body>
            <PrimaryButton
              label={`Ya tengo a ${view.petName}`}
              disabled={busy}
              onPress={() => void run(buildAcceptReturn(), view.petName)}
            />
          </View>
        </Card>
      ) : null}

      {canReject ? (
        <Card title="Rechazar la devolución">
          <View style={{ gap: 12 }}>
            <Body>Quien la tiene va a recibir tu respuesta con el motivo.</Body>
            <TextField
              label="Motivo"
              required
              multiline
              maxLength={RETURN_REJECT_REASON_MAX}
              onChangeText={setRejectReason}
              placeholder="No puedo recibirla ahora…"
              value={rejectReason}
            />
            <SecondaryButton
              label="Rechazar"
              disabled={busy}
              onPress={() => void run(buildRejectReturn(rejectReason), view.petName)}
            />
          </View>
        </Card>
      ) : null}

      {canPropose ? (
        <Card title="Devolver a la organización">
          <View style={{ gap: 12 }}>
            <Body>
              La organización recibe tu propuesta y tiene que aceptarla. Hasta que confirmen la
              recepción, {view.petName} sigue a tu nombre.
            </Body>
            <Choice
              label="Razón de la devolución"
              required
              options={REASON_VALUES}
              selected={proposeReason}
              onSelect={setProposeReason}
              optionLabel={(reason) =>
                RETURN_REASON_CHOICES.find((c) => c.reason === reason)?.label ?? reason
              }
            />
            <TextField
              label="Comentario (opcional)"
              multiline
              maxLength={RETURN_NOTES_MAX}
              onChangeText={setProposeNotes}
              placeholder="Algo que la organización deba saber…"
              value={proposeNotes}
            />
            <PrimaryButton
              label="Proponer la devolución"
              disabled={busy}
              onPress={() =>
                void run(buildProposeReturn(proposeReason ?? "", proposeNotes), view.petName)
              }
            />
          </View>
        </Card>
      ) : null}
    </Screen>
  );
}
