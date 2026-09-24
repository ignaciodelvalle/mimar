// ACOMPAÑAMIENTO DE ADOPCIÓN — the titular's surface, in its three states.
//
// THE OTHER HALF OF A BANNER THE FACE COULD ONLY READ. `OwnerFace` has said
// "hay una propuesta pendiente con X" / "X está buscándole un nuevo hogar" since
// it was built; until this screen nothing in the app could ask for one, cancel
// one or end one. All three reach the IDENTICAL use-cases the web's
// `buscar-hogar` page reaches, through `GET|POST /pets/{token}/rehome`.
//
// ONE SCREEN, THREE STATES, the web's `TitularRehomePanel` shape: the picker
// while nothing runs, the pending callout with its cancel, the active callout
// with its withdraw. The two exits confirm; the ask does not (see the
// view-model for why that asymmetry is the web's and not this file's).
//
// THE LEVERS ARE THE SERVER'S. `capabilities` carries three booleans and this
// screen draws a lever only where its flag is true — it never derives one from
// `state.kind`, and it never derives one from "this pet is mine". A co-owner
// who somehow arrives here reads `rehome_forbidden`'s sentence, not a form.
//
// ONE KEY PER EXIT ATTEMPT. Each exit holds an attempt session (the shape
// `LostScreen` and `EventDetailScreen` use): the key is minted on the first tap
// and reused on every retry of that same act, so a retry that lost its response
// is recognised by the server's ledger and answers `replayed: true` — which
// this screen renders as done, in the past perfect, never as a refusal. The
// session restarts after a landed exit, so a LATER, genuinely new cancel gets a
// key of its own.
//
// THE READ IS RE-DONE AFTER EVERY WRITE, NOT PATCHED. The ack carries a code
// and a flag; the next state — who was asked, what may now be done — is the
// server's to compute, and a screen that guessed it would be the face's banner
// all over again.
//
// AND A RE-READ THAT FAILS KEEPS WHAT IS ON SCREEN (`ui/reload-state.ts`). Only
// the first read may draw the full-screen error. After a landed exit the ack is
// on screen and true; if the re-read behind it dies, blanking the screen to
// "no pudimos conectarnos" tells the person their cancel failed, hides the
// callout that says where things stand, and takes every lever with it — a
// dead end they cannot see through. The last state stays, under a banner that
// says it may be old and offers the read again. A REFUSAL on that re-read is
// not a hiccup and does empty the screen: access is what changed.
//
// THE ASK'S REPLAY IS A REFUSAL BY WIRE AND A SUCCESS BY MEANING. It carries
// no key, so its retry answers `rehome_already_open`, not `replayed: true`
// (`isLookAgainRefusal` in the view-model). The screen re-reads on it, and the
// pending callout that comes back IS the ask's success notice.

import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { PetRehomeOrgV1, PetRehomeV1 } from "@dim/contract/api";
import type { RehomeCommandInput } from "@dim/contract/input";

import type { ApiResult } from "../api/client";
import { fetchPetRehome, sendRehomeCommand } from "../api/endpoints";
import { apiErrorMessage } from "../api/error-copy";
import { sessionPort } from "../auth/session-store";
import { Body, Card, Loading, StaleNotice } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { Callout, PrimaryButton, Screen, SecondaryButton, Title } from "../ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../ui/reload-state";
import { editPetRoute } from "../ui/routes";
import { COLORS, SPACE, TYPE } from "../ui/theme";
import { useScrollToError } from "../ui/use-scroll-to-error";

import { createAttemptSession } from "./idempotency";
import {
  type ExitCopy,
  PICKER_FOOTNOTE,
  ackMessage,
  activeCopy,
  buildRequestSponsorship,
  buildWithdrawRequest,
  buildWithdrawSponsorship,
  cancelExitCopy,
  emptyPickerReason,
  introLine,
  isLookAgainRefusal,
  orgRowCaption,
  pendingCopy,
  withdrawExitCopy,
} from "./rehome-view-model";

/**
 * One sentence per failure arm. No arm falls through to a generic shrug, and
 * none of them quotes anything the server sent.
 */
function failureMessage(result: ApiResult<unknown>): string {
  switch (result.outcome) {
    case "api-error":
      return apiErrorMessage(result.code);
    case "unsupported-version":
      return "Esta versión de la app no puede manejar el acompañamiento de adopción. Actualizá la app.";
    case "malformed":
      return "La respuesta del servidor no se pudo leer.";
    case "unreachable":
      return "No pudimos conectarnos. Revisá tu conexión.";
    default:
      return "No pudimos completar la acción.";
  }
}

type ScreenState =
  | { phase: "loading" }
  | ReadyState<PetRehomeV1>
  | { phase: "failed"; message: string };

type Notice = { tone: "ok" | "err"; message: string } | null;

/** What is busy right now: one org's ask, one of the exits, or nothing. */
type Busy =
  | { what: "request"; orgPublicToken: string }
  | { what: "cancel" }
  | { what: "withdraw" }
  | null;

export function RehomeScreen({ publicToken }: { publicToken: string }) {
  const router = useRouter();
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<Busy>(null);
  // ONE KEY PER EXIT — see the header. `useRef` and not `useState` because a
  // re-render must not be able to produce a different key.
  const cancelAttempt = useRef(createAttemptSession());
  const withdrawAttempt = useRef(createAttemptSession());
  const { anchorRef: errorAnchor, scrollRef } = useScrollToError(
    notice !== null && notice.tone === "err" ? notice.message : null,
  );

  // A stale response must not overwrite a newer one when the banner's retry
  // and a write's re-read overlap — the counter every sibling screen keeps.
  const generation = useRef(0);

  /**
   * `initial` is the one read allowed to blank the screen; `refresh` — after a
   * write, from the stale banner — keeps the last state on an outage.
   * Answers whether the read landed, so a caller can decide what to say.
   */
  const load = useCallback(
    async (mode: "initial" | "refresh"): Promise<boolean> => {
      const mine = ++generation.current;
      if (mode === "initial") setState({ phase: "loading" });
      const result = await fetchPetRehome(sessionPort, publicToken);
      if (mine !== generation.current) return false;
      if (result.outcome === "ok") {
        setState(loaded(result.payload));
        return true;
      }
      setState((current) => reloadFailed(current, result, failureMessage(result)));
      return false;
    },
    [publicToken],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  const run = useCallback(
    async (input: RehomeCommandInput, key: string | null, what: Busy) => {
      setNotice(null);
      setBusy(what);
      const result = await sendRehomeCommand(sessionPort, publicToken, input, key);
      setBusy(null);
      if (result.outcome !== "ok") {
        // A refusal whose whole instruction is "look again": the screen looks.
        // If the re-read lands, the state it draws is the answer (the ask's
        // pending callout, the exit's picker) and the sentence would only
        // contradict it. If it does not land, the sentence stands — and the
        // stale banner under it now carries the retry the sentence asks for.
        if (result.outcome === "api-error" && isLookAgainRefusal(result.code)) {
          const landed = await load("refresh");
          if (!landed) setNotice({ tone: "err", message: failureMessage(result) });
          return false;
        }
        setNotice({ tone: "err", message: failureMessage(result) });
        return false;
      }
      const message = ackMessage(result.payload);
      if (message !== null) setNotice({ tone: "ok", message });
      // The next state is the server's — re-read rather than guess. The ack
      // stays on screen whether or not this lands: it is true either way.
      await load("refresh");
      return true;
    },
    [load, publicToken],
  );

  const ask = useCallback(
    (org: PetRehomeOrgV1) => {
      const built = buildRequestSponsorship(org.publicToken);
      if (!built.ok) {
        setNotice({ tone: "err", message: built.message });
        return;
      }
      void run(built.input, null, { what: "request", orgPublicToken: org.publicToken });
    },
    [run],
  );

  const cancel = useCallback(async () => {
    const built = buildWithdrawRequest();
    if (!built.ok) return;
    const landed = await run(built.input, cancelAttempt.current.key(), { what: "cancel" });
    // A landed exit ends this attempt; a refused one keeps the key for the retry.
    if (landed) cancelAttempt.current.restart();
  }, [run]);

  const withdraw = useCallback(async () => {
    const built = buildWithdrawSponsorship();
    if (!built.ok) return;
    const landed = await run(built.input, withdrawAttempt.current.key(), { what: "withdraw" });
    if (landed) withdrawAttempt.current.restart();
  }, [run]);

  if (state.phase === "loading") return <Loading label="Leyendo el acompañamiento…" />;

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Acompañamiento de adopción</Title>
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load("initial")} />
      </Screen>
    );
  }

  const view = state.view;
  const petName = view.petName;

  return (
    <Screen scrollRef={scrollRef}>
      <Title>Acompañamiento de adopción para {petName}</Title>
      <Body>{introLine(petName)}</Body>

      {state.staleFailure !== null ? (
        <StaleNotice message={state.staleFailure} onRetry={() => void load("refresh")} />
      ) : null}

      {notice !== null && (
        <View ref={errorAnchor}>
          <Callout tone={notice.tone}>
            <Body>{notice.message}</Body>
          </Callout>
        </View>
      )}

      {view.state.kind === "none" ? (
        <OrgPicker
          view={view}
          busy={busy}
          onAsk={ask}
          onEditPet={() => router.push(editPetRoute(publicToken))}
        />
      ) : null}

      {view.state.kind === "pending" ? (
        <StateCard
          copy={pendingCopy(view.state, petName)}
          exit={
            view.capabilities.canWithdrawRequest
              ? {
                  copy: cancelExitCopy(view.state.orgDisplayName),
                  busy: busy?.what === "cancel",
                  onRun: cancel,
                }
              : null
          }
          disabled={busy !== null}
        />
      ) : null}

      {view.state.kind === "active" ? (
        <StateCard
          copy={activeCopy(view.state, petName)}
          exit={
            view.capabilities.canWithdrawSponsorship
              ? {
                  copy: withdrawExitCopy(view.state.orgDisplayName, petName),
                  busy: busy?.what === "withdraw",
                  onRun: withdraw,
                }
              : null
          }
          disabled={busy !== null}
        />
      ) : null}
    </Screen>
  );
}

/**
 * none — the verified orgs covering the pet's zone, one ask each, or the honest
 * empty state when nobody does.
 */
function OrgPicker({
  view,
  busy,
  onAsk,
  onEditPet,
}: {
  view: PetRehomeV1;
  busy: Busy;
  onAsk: (org: PetRehomeOrgV1) => void;
  onEditPet: () => void;
}) {
  const empty = emptyPickerReason(view);
  if (empty !== null) {
    return (
      <Card title="Organizaciones">
        <View style={styles.stack}>
          <Body>{empty.message}</Body>
          {empty.kind === "no_province" ? (
            <SecondaryButton label="Editar mascota" onPress={onEditPet} />
          ) : null}
        </View>
      </Card>
    );
  }
  return (
    <>
      <Card title="Organizaciones">
        <View style={styles.stack}>
          {view.orgs.map((org) => {
            const asking = busy?.what === "request" && busy.orgPublicToken === org.publicToken;
            return (
              <View key={org.publicToken} style={styles.orgRow}>
                <Text style={styles.orgName}>{org.displayName}</Text>
                <Text style={styles.orgCaption}>{orgRowCaption(org)}</Text>
                {view.capabilities.canRequest ? (
                  <PrimaryButton
                    label={asking ? "Enviando…" : "Pedir acompañamiento"}
                    disabled={busy !== null}
                    onPress={() => onAsk(org)}
                  />
                ) : null}
              </View>
            );
          })}
        </View>
      </Card>
      {view.capabilities.canRequest ? <Body>{PICKER_FOOTNOTE}</Body> : null}
    </>
  );
}

/**
 * pending / active — the callout that says where things stand, and the exit
 * under it, confirmed before it fires.
 *
 * THE CONFIRMATION HAS NO HEADING, because the web's has none: a bordered box
 * with the explanation, the seal button carrying the confirm label, and
 * "Volver" (`TitularRehomePanel.tsx`, `ExitControl`). The first draft titled
 * the box with the confirm label, which put "Confirmar la cancelación" on
 * screen twice — once as a heading nobody wrote — and it read as if there were
 * two things to confirm.
 */
function StateCard({
  copy,
  exit,
  disabled,
}: {
  copy: { title: string; body: string; reference: string | null };
  exit: { copy: ExitCopy; busy: boolean; onRun: () => void } | null;
  disabled: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <View style={styles.stack}>
      <Callout tone="neutral" title={copy.title}>
        <Body>{copy.body}</Body>
        {copy.reference ? <Text style={styles.reference}>{copy.reference}</Text> : null}
      </Callout>
      {exit === null ? null : confirming ? (
        <Card>
          <View style={styles.stack}>
            <Body>{exit.copy.explanation}</Body>
            <PrimaryButton
              tone="seal"
              label={exit.busy ? exit.copy.busy : exit.copy.confirm}
              disabled={disabled}
              onPress={() => {
                exit.onRun();
                setConfirming(false);
              }}
            />
            <SecondaryButton
              label="Volver"
              disabled={disabled}
              onPress={() => setConfirming(false)}
            />
          </View>
        </Card>
      ) : (
        <PrimaryButton
          tone="seal"
          label={exit.busy ? exit.copy.busy : exit.copy.trigger}
          disabled={disabled}
          onPress={() => setConfirming(true)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: SPACE.sm },
  orgRow: {
    gap: SPACE.xs,
    paddingVertical: SPACE.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  orgName: { fontFamily: FONTS.serif, fontSize: TYPE.base, color: COLORS.ink },
  orgCaption: { fontFamily: FONTS.mono, fontSize: TYPE.sm, color: COLORS.inkMuted },
  reference: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.sm,
    color: COLORS.inkSoft,
    marginTop: SPACE.xs,
  },
});
