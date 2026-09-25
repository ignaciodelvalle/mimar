// CHAPA FÍSICA — el §4.20 demand-signal placeholder que la web ya tiene
// (PhysicalTagInterestSheet.tsx), servido acá por primera vez (D2, 2026-09-25).
//
// LA MISMA ACCIÓN, DOS SUPERFICIES. `togglePhysicalTagInterestAction` y esta
// pantalla llegan al MISMO use-case (`togglePhysicalTagInterest`) a través de
// `POST /pets/{token}/profile` — ver el comentario de `commands.ts` sobre el
// join que cierra `check-owner-surface-parity.ts`. No hay una segunda regla
// de negocio inventada acá: quién puede alternar el interés lo dice
// `capabilities.canTogglePhysicalTagInterest`, la MISMA que el endpoint
// enforce.
//
// SIGUE SIENDO UN PLACEHOLDER, y la copy lo dice: "estamos midiendo interés,
// no se cobra todavía" es una afirmación de producto y esta app tiene que
// decir lo mismo que la web, no una versión propia.
//
// NO HAY "CANALES DISPONIBLES EN TU ZONA" ACÁ. La web resuelve esa sección con
// `PhysicalCredentialChannels`, una regla de negocio por jurisdicción que este
// endpoint no expone todavía — agregarla es un cambio de scope propio, no
// parte de D2.

import { useCallback, useEffect, useState } from "react";

import { apiFailureMessage } from "../api/client";
import { fetchPetProfileEdit, sendPetProfileCommand } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body, Card, Loading, Unavailable } from "../ui/components";
import { Callout, PrimaryButton, Screen, SecondaryButton, Title } from "../ui/kit";
import {
  buildTogglePhysicalTagInterest,
  physicalTagInterestBody,
  physicalTagInterestRequestedAtLabel,
  physicalTagInterestSavedLabel,
  physicalTagInterestTitle,
} from "./pet-profile-edit-view-model";

type State =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  /** The server refused THIS caller the door — org member, mostly. */
  | { kind: "forbidden" }
  | {
      kind: "known";
      petName: string;
      interested: boolean;
      requestedAt: string | null;
    };

export function PhysicalTagInterestScreen({ publicToken }: { publicToken: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; message: string } | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const result = await fetchPetProfileEdit(sessionPort, publicToken);
    if (result.outcome !== "ok") {
      setState({
        kind: "unavailable",
        message: apiFailureMessage(result) ?? "No pudimos leer esta sección.",
      });
      return;
    }
    const { payload } = result;
    if (
      !payload.capabilities.canTogglePhysicalTagInterest ||
      payload.physicalTagInterest === null
    ) {
      setState({ kind: "forbidden" });
      return;
    }
    setState({
      kind: "known",
      petName: payload.identity.name,
      interested: payload.physicalTagInterest.interested,
      requestedAt: payload.physicalTagInterest.requestedAt,
    });
  }, [publicToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(async () => {
    if (state.kind !== "known") return;
    setNotice(null);
    const built = buildTogglePhysicalTagInterest();
    if (!built.ok) {
      // UNREACHABLE IN PRACTICE — the command carries no field a person could
      // get wrong. Kept because `buildTogglePhysicalTagInterest` still runs the
      // schema, and a refusal must have SOMEWHERE to go rather than silently
      // proceeding with a body the server would reject anyway.
      setNotice({ tone: "err", message: built.message });
      return;
    }
    setBusy(true);
    const result = await sendPetProfileCommand(sessionPort, publicToken, built.input);
    setBusy(false);
    if (result.outcome !== "ok") {
      setNotice({
        tone: "err",
        message: apiFailureMessage(result) ?? "No pudimos guardar el interés.",
      });
      return;
    }
    const ack = result.payload;
    if (ack.command !== "toggle_physical_tag_interest") {
      setNotice({ tone: "err", message: "La respuesta del servidor no se pudo leer." });
      return;
    }
    setNotice({ tone: "ok", message: physicalTagInterestSavedLabel(ack.state) });
    setState({
      kind: "known",
      petName: state.petName,
      interested: ack.state === "interested",
      // A FRESH TAP, A FRESH DATE. The server does not echo one on the ack, and
      // "now" is honest here: this request is either the first `interested`
      // this row has ever seen, or a cancel — which shows no date at all.
      requestedAt: ack.state === "interested" ? new Date().toISOString() : null,
    });
  }, [state, publicToken]);

  if (state.kind === "loading") {
    return (
      <Screen>
        <Loading label="Leyendo…" />
      </Screen>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <Screen>
        <Unavailable title="Chapa física" message={state.message} />
        <SecondaryButton label="Volver a intentar" onPress={() => void load()} />
      </Screen>
    );
  }

  if (state.kind === "forbidden") {
    return (
      <Screen>
        <Title>Chapa física</Title>
        <Callout tone="neutral" title="No disponible">
          <Body>Esta acción es del dueño o de quien tiene la mascota a su cargo.</Body>
        </Callout>
      </Screen>
    );
  }

  const requestedAtLabel = physicalTagInterestRequestedAtLabel(state.requestedAt);

  return (
    <Screen>
      <Title>Chapa física</Title>
      <Card>
        <Body>{physicalTagInterestTitle(state.petName, state.interested)}</Body>
        <Body>{physicalTagInterestBody(state.petName, state.interested)}</Body>
        {state.interested && requestedAtLabel ? <Body>{requestedAtLabel}</Body> : null}
        {state.interested ? null : <Body>Estamos midiendo interés — no se cobra todavía.</Body>}
        <PrimaryButton
          label={busy ? "Guardando…" : state.interested ? "Cancelar interés" : "Me interesa"}
          disabled={busy}
          onPress={() => void toggle()}
        />
      </Card>
      {notice !== null ? (
        <Callout tone={notice.tone}>
          <Body>{notice.message}</Body>
        </Callout>
      ) : null}
    </Screen>
  );
}
