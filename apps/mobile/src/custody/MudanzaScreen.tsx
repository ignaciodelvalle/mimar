// MUDANZA — "esta mascota ahora vive en otro lado".
//
// THE ONE FORM IN THIS APP WHOSE FIELD IS A CATALOG AND NOT A TEXT BOX, and the
// reason is the same one the alta form has: the (province, locality) pair is
// resolved against the INDEC catalog in STRICT mode before it is written, so a
// free-text destination would be refused by the server for reasons a person
// typing cannot see. `LocalityPicker` is reused rather than rebuilt — it already
// owns the debounce, the stale-response guard and the "escribí al menos dos
// letras" rule, and a second copy would be a second place for those to drift.
//
// WHAT THIS SCREEN READS AND WHY IT IS `/pets/{token}` AND NOT A DOOR OF ITS OWN
// ---------------------------------------------------------------------------
// The move endpoint is POST-only, deliberately: everything a mudanza form needs
// to draw itself already exists on the owner face — the animal's name and its
// current jurisdiction — and `GET /localities` is the same public typeahead the
// alta form spends. A third read would be a route, a per-IP bucket and a payload
// version bought to re-send two fields.
//
// IT DOES NOT PRE-JUDGE WHO MAY MOVE THE ANIMAL. There is no capability flag on
// this feature and no local guess: the rule is `requireTitularAccess`'s — every
// active holder except a caretaker, the org path included — and this screen
// posts and renders the refusal. A local "am I the owner?" would refuse a foster
// the browser admits, which is the failure `TransferInitiateScreen` records in
// the other direction.
//
// THE CURRENT JURISDICTION IS SHOWN AND IT IS NOT DECORATION. The server refuses
// a destination equal to the origin (`move_same_locality`, 409), so a person who
// cannot see where the animal is filed today cannot tell a refusal from a bug.
// And when the identity section comes back `unavailable`, this screen says the
// read failed rather than saying the animal has no locality — the second
// sentence would invite a move nobody needs.

import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import { MOVE_REASON_MAX } from "@dim/contract/input";

import type { ApiResult } from "../api/client";
import { fetchOwnerPetDetail, sendPetMoveCommand } from "../api/endpoints";
import { apiErrorMessage } from "../api/error-copy";
import { sessionPort } from "../auth/session-store";
import { LocalityPicker } from "../pets/LocalityPicker";
import { Body, Card, Loading } from "../ui/components";
import { Callout, PrimaryButton, Screen, SecondaryButton, TextField, Title } from "../ui/kit";
import { useDraftDiscardGuard } from "../ui/use-draft-discard-guard";
import { useScrollToError } from "../ui/use-scroll-to-error";

import {
  type CurrentJurisdiction,
  EMPTY_MOVE_DRAFT,
  type MoveDraft,
  buildMove,
  currentJurisdiction,
  jurisdictionAfterMove,
  moveRecordedMessage,
  petNameFrom,
} from "./mudanza-view-model";

/**
 * One sentence per failure arm. No arm falls through to a generic shrug, and
 * none of them quotes anything the server sent.
 */
function failureMessage(result: ApiResult<unknown>): string {
  switch (result.outcome) {
    case "api-error":
      return apiErrorMessage(result.code);
    case "unsupported-version":
      return "Esta versión de la app no puede registrar la mudanza. Actualizá la app.";
    case "malformed":
      return "La respuesta del servidor no se pudo leer.";
    case "unreachable":
      return "No pudimos conectarnos. Revisá tu conexión.";
    default:
      return "No pudimos registrar la mudanza.";
  }
}

type LoadState =
  | { phase: "loading" }
  | { phase: "failed"; message: string }
  | { phase: "ready"; petName: string | null; where: CurrentJurisdiction };

type Notice = { tone: "ok" | "err"; message: string } | null;

export function MudanzaScreen({ publicToken }: { publicToken: string }) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [draft, setDraft] = useState<MoveDraft>(EMPTY_MOVE_DRAFT);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  // A REFUSAL moves the view; the "ok" notice does not. Going to fetch somebody
  // who just succeeded is a jump nobody asked for.
  const { anchorRef: errorAnchor, scrollRef } = useScrollToError(
    notice !== null && notice.tone === "err" ? notice.message : null,
  );
  /** Set once the move landed — the form is gone and only the ack remains. */
  const [done, setDone] = useState(false);
  // THE BACK GESTURE MAY NOT DISCARD A TYPED MOVE (critic gap 2). `done`
  // clears it: once the move landed there is nothing left to lose, and asking
  // would trap the person on an acknowledgement.
  useDraftDiscardGuard(!done && draft !== EMPTY_MOVE_DRAFT);

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    const result = await fetchOwnerPetDetail(sessionPort, publicToken);
    if (result.outcome !== "ok") {
      setState({ phase: "failed", message: failureMessage(result) });
      return;
    }
    setState({
      phase: "ready",
      petName: petNameFrom(result.payload),
      where: currentJurisdiction(result.payload),
    });
  }, [publicToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(async () => {
    setNotice(null);
    // The CONTRACT's schema, run locally first, so a missing destination gets a
    // field sentence instead of a round trip that answers `invalid_request` with
    // no field detail. Same rule every other form in this app follows.
    const built = buildMove(draft);
    if (!built.ok) {
      setNotice({ tone: "err", message: built.message });
      return;
    }

    setBusy(true);
    const result = await sendPetMoveCommand(sessionPort, publicToken, built.input);
    setBusy(false);
    if (result.outcome !== "ok") {
      setNotice({ tone: "err", message: failureMessage(result) });
      return;
    }
    // THE ACK'S OWN PAIR, not the draft: what was stored is the catalog's
    // spelling, and a screen that echoed the typed value would be reporting a
    // registration that did not happen in those words.
    setNotice({ tone: "ok", message: moveRecordedMessage(result.payload.jurisdiction) });
    // "DÓNDE FIGURA HOY" IS NOW STALE, and it is the card labelled "hoy"
    // (A4-R-03). It was read on mount and left standing, so the ack naming the
    // NEW locality sat directly under a card naming the old one. Patched from
    // the same canonical pair the ack carries — see `jurisdictionAfterMove` for
    // why this is not a re-read.
    setState((current) =>
      current.phase === "ready"
        ? { ...current, where: jurisdictionAfterMove(result.payload.jurisdiction) }
        : current,
    );
    setDone(true);
  }, [draft, publicToken]);

  if (state.phase === "loading") {
    return (
      <Screen>
        <Title>Registrar una mudanza</Title>
        <Loading label="Cargando…" />
      </Screen>
    );
  }

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Registrar una mudanza</Title>
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load()} />
      </Screen>
    );
  }

  const subject = state.petName ?? "esta mascota";

  return (
    // `keyboardAvoiding` because the destination search and the reason are both
    // text inputs down a scroll — without it the keyboard covers the field being
    // typed into.
    <Screen keyboardAvoiding scrollRef={scrollRef}>
      <Title>Mudanza de {subject}</Title>
      <Body>
        La jurisdicción decide qué autoridad responde por {subject} y qué vacunas le corresponden,
        así que el movimiento queda anotado en la libreta.
      </Body>

      {notice !== null && (
        <View ref={errorAnchor}>
          <Callout tone={notice.tone}>
            <Body>{notice.message}</Body>
          </Callout>
        </View>
      )}

      <Card title="Dónde figura hoy">
        <CurrentWhere where={state.where} />
      </Card>

      {done ? (
        // THE FORM IS GONE, not merely disabled. A second submit of the same
        // destination is refused by the server as `move_same_locality`, and a
        // still-visible "Registrar" over an ack that says it worked is an
        // invitation to meet a refusal that reads like a failure.
        <Card title="Listo">
          <Body>Podés cerrar esta pantalla.</Body>
        </Card>
      ) : (
        <Card title="Nueva localidad">
          <View style={{ gap: 12 }}>
            <LocalityPicker
              provinceCode={draft.provinceCode}
              localityName={draft.localityName}
              onSelect={(selection) =>
                setDraft({
                  ...draft,
                  provinceCode: selection.provinceCode,
                  localityName: selection.localityName,
                  // A2-alta-asentar-03: WHICH San Pedro. Without it the server
                  // resolves the name and lands on the alphabetically first
                  // department, so the ack named a province nobody chose and the
                  // correcting move was refused as `move_same_locality`.
                  localityIndecId: selection.localityIndecId,
                })
              }
            />
            <TextField
              label="Motivo (opcional)"
              maxLength={MOVE_REASON_MAX}
              onChangeText={(reason) => setDraft({ ...draft, reason })}
              placeholder="Mudanza, cambio de tenencia…"
              value={draft.reason}
            />
            <PrimaryButton
              label="Registrar mudanza"
              // The destination is the only hard requirement, and it is checked
              // AGAIN in `submit` — the button's `disabled` is an affordance and
              // not the gate. `buildMove` is what refuses, so a button that
              // somehow stayed enabled writes nothing.
              disabled={busy || draft.localityName.length === 0}
              onPress={() => void submit()}
            />
          </View>
        </Card>
      )}
    </Screen>
  );
}

/** The three states of "where does this animal live", kept distinct. */
function CurrentWhere({ where }: { where: CurrentJurisdiction }) {
  switch (where.kind) {
    case "known":
      return <Body>{where.label}</Body>;
    case "none":
      return (
        <Body>
          Esta mascota no tiene una localidad registrada. Elegir una acá la deja anotada por primera
          vez.
        </Body>
      );
    case "unavailable":
      // NOT "no tiene localidad". The section failed to load, and saying the
      // animal has none would invite a move nobody needs — the same distinction
      // `CredentialSection` exists to force.
      return (
        <Body>No pudimos leer dónde figura hoy. El registro de la mudanza igual funciona.</Body>
      );
  }
}
