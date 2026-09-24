// TRANSFERENCIAS — the hub. What is coming to me, and what I sent.
//
// THE ONE SCREEN IN THIS APP THAT IS NOT ABOUT A PET IT HOLDS. Every other
// authenticated screen starts from `publicToken`, because it is about one animal
// the person is responsible for. Half of this one is about animals they are NOT
// responsible for — a proposal is an offer from somebody else's pet — which is
// why the read hangs off `/me` and why this screen takes no token.
//
// It mirrors the web's `/transferencias`, in its three sections and its order:
// Recibidas · Pendientes, Recibidas · Historial, Enviadas. History is only drawn
// when it has rows, exactly as on the web, because an empty "Historial" heading
// above nothing is furniture.
//
// EVERY AFFORDANCE COMES FROM THE SERVER. There are no controls on this screen —
// it is a list — but the SENTENCE under each row comes from `capabilities` and
// `expired`, both computed server-side against the addressee rule and the
// server's clock. A screen that decided "this one is answerable" from `status`
// would tell the sender of a proposal that they can accept it.

import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";

import type {
  MyCaretakerGrantV1,
  MyCaretakerGrantsV1,
  MyTransferV1,
  MyTransfersV1,
} from "@dim/contract/api";

import type { ApiResult } from "../api/client";
import { fetchMyCaretakerGrants, fetchMyTransfers } from "../api/endpoints";
import { apiErrorMessage } from "../api/error-copy";
import { sessionPort } from "../auth/session-store";
import { Body, Card, EmptyState, StaleNotice } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { Callout, Eyebrow, Screen, SecondaryButton, Title } from "../ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../ui/reload-state";
import { ListSkeleton } from "../ui/skeleton";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TRACKING, TYPE } from "../ui/theme";
import { useReconnect } from "../ui/use-reconnect";

import {
  caretakerCounterpartyLabel,
  caretakerPeriodLabel,
} from "../caretakers/caretakers-view-model";
import {
  emptyIncomingLabel,
  emptyOutgoingLabel,
  transferCounterpartyLabel,
  transferDeadlineLabel,
  transferStatusLabel,
} from "./transfers-view-model";

/** One sentence per failure arm. No arm falls through to a generic shrug. */
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
      return "No pudimos leer tus transferencias.";
  }
}

/**
 * The hub's two reads, combined into one view.
 *
 * T4-M4: a caretaker invitation used to be reachable only through the
 * e-mail/notification link that named `/cuidado/{grantToken}` — nowhere in the
 * app could an invitee go LOOKING for one. `fetchMyCaretakerGrants` reads the
 * same hub the deep-link screen and the web's `/cuidado` page already use, so
 * this section shows nothing that was not already reachable through one of
 * those two doors.
 */
type HubView = { transfers: MyTransfersV1; caretakerGrants: MyCaretakerGrantsV1 };

type ScreenState =
  | { phase: "loading" }
  | ReadyState<HubView>
  | { phase: "failed"; message: string };

export function TransfersScreen({
  onOpen,
  onOpenCaretakerGrant,
}: {
  onOpen: (transferToken: string) => void;
  onOpenCaretakerGrant: (grantToken: string) => void;
}) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });

  // Pull-to-refresh (QOL 2026-09-01): the shared Screen carried the prop all
  // along and /mascotas + notificaciones already used it — these lists were
  // the odd ones out. A refresh keeps the list on screen instead of blanking
  // to the loading phase; only the very first load does that.
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (mode: "initial" | "refresh" = "initial") => {
    if (mode === "refresh") setRefreshing(true);
    else setState({ phase: "loading" });
    // BOTH READS, TOGETHER, AND EITHER FAILING FAILS THE SCREEN. A caretaker
    // invitation is exactly the row `reload-state.ts`'s header warns about
    // hiding: "what is being missed is somebody waiting for an answer about an
    // animal." A partial render that dropped the Cuidados section on a
    // transient error would be indistinguishable on screen from "no tenés
    // ninguna", which is the lie this screen exists to avoid telling.
    const [transfersResult, grantsResult] = await Promise.all([
      fetchMyTransfers(sessionPort),
      fetchMyCaretakerGrants(sessionPort),
    ]);
    if (mode === "refresh") setRefreshing(false);
    if (transfersResult.outcome === "ok" && grantsResult.outcome === "ok") {
      setState(
        loaded({ transfers: transfersResult.payload, caretakerGrants: grantsResult.payload }),
      );
      return;
    }
    const failed = transfersResult.outcome !== "ok" ? transfersResult : grantsResult;
    // KEEPING WHAT IS ON SCREEN (S-2). A failed re-read of a hub whose rows are
    // already drawn must not delete them: the proposals are still pending and
    // still expiring, and the network is not the subject of this screen.
    setState((current) => reloadFailed(current, failed, failureMessage(failed)));
  }, []);

  // ON FOCUS, NOT ONLY ON MOUNT (native QA batch 3, C4). Opening a proposal
  // pushes `transferencias/[transferToken]` on top of this screen; popping back
  // — after a reject, which answers in place and leaves the person to go back
  // themselves, or after an accept, whose `replace` still leaves the hub one
  // step behind in the stack — does not remount it. A plain mount effect left
  // the hub showing the pending state from before the decision. Same fix and
  // same reasoning as `TurnosScreen`.
  //
  // THE RETURN IS A "refresh" AND NOT AN "initial" READ, and that distinction is
  // the whole difference between a fix and an annoyance: `initial` sets
  // `phase: "loading"`, which would blank the hub to a skeleton every single
  // time somebody comes back from a proposal's detail screen. `refresh` keeps
  // the rows on screen and shows the pull-to-refresh spinner instead. The FIRST
  // appearance still takes the loading phase, because there is nothing yet to
  // keep.
  const hasLoaded = useRef(false);
  useFocusEffect(
    useCallback(() => {
      void load(hasLoaded.current ? "refresh" : "initial");
      hasLoaded.current = true;
    }, [load]),
  );

  // WHEN THE NETWORK COMES BACK, TRY AGAIN (B-05, the other half of S-2). Keeping
  // the last good payload stops a dead spot from deleting the hub; this stops the
  // hub sitting stale beside an offline banner that has already cleared itself. A
  // `refresh`, so nothing on screen moves while it happens.
  useReconnect(() => void load("refresh"));

  const refresher = (
    <RefreshControl
      colors={[COLORS.accent]}
      onRefresh={() => void load("refresh")}
      refreshing={refreshing}
      tintColor={COLORS.accent}
    />
  );

  if (state.phase === "loading")
    return (
      <Screen>
        <ListSkeleton rows={3} label="Cargando transferencias…" />
      </Screen>
    );

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Transferencias</Title>
        {/* NOT an empty list. A read that failed and a person with no proposals
            are different facts, and "no tenés transferencias pendientes" over a
            server outage hides a seven-day window that closes by itself. */}
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load()} />
      </Screen>
    );
  }

  const { incoming, outgoing } = state.view.transfers;
  const caretakerIncoming = state.view.caretakerGrants.incoming;
  const caretakerInvitations = caretakerIncoming.filter((g) => g.status === "pending");
  const activeCaretakerGrants = caretakerIncoming.filter((g) => g.status === "accepted");

  return (
    <Screen refreshControl={refresher}>
      <Title>Transferencias</Title>
      <Body>Transferencias de mascotas recibidas y enviadas.</Body>

      {state.staleFailure === null ? null : (
        <StaleNotice message={state.staleFailure} onRetry={() => void load("refresh")} />
      )}

      <View style={styles.section}>
        <Eyebrow>Recibidas · Pendientes</Eyebrow>
        {incoming.pending.length === 0 ? (
          <EmptyState
            headline={emptyIncomingLabel()}
            body="Cuando alguien te ofrezca la titularidad de una mascota, la propuesta aparece acá."
          />
        ) : (
          incoming.pending.map((transfer) => (
            <TransferRow key={transfer.transferToken} transfer={transfer} onOpen={onOpen} />
          ))
        )}
      </View>

      {/* Drawn only when it has rows — an empty "Historial" is furniture. */}
      {incoming.history.length > 0 && (
        <View style={styles.section}>
          <Eyebrow>Recibidas · Historial</Eyebrow>
          {incoming.history.map((transfer) => (
            <TransferRow key={transfer.transferToken} transfer={transfer} onOpen={onOpen} />
          ))}
        </View>
      )}

      {/* CUIDADOS — invitaciones de cuidado temporal, lado del invitado (T4-M4). */}
      <View style={styles.section}>
        <Eyebrow>Cuidados · Invitaciones</Eyebrow>
        {caretakerInvitations.length === 0 ? (
          <EmptyState
            headline="No tenés invitaciones a cuidar mascotas pendientes."
            body="Cuando alguien te proponga cuidar a su mascota, la invitación aparece acá."
          />
        ) : (
          caretakerInvitations.map((grant) => (
            <CaretakerGrantRow key={grant.grantToken} grant={grant} onOpen={onOpenCaretakerGrant} />
          ))
        )}
      </View>

      {/* Drawn only when it has rows — an empty section is furniture. */}
      {activeCaretakerGrants.length > 0 && (
        <View style={styles.section}>
          <Eyebrow>Cuidados · Activos</Eyebrow>
          {activeCaretakerGrants.map((grant) => (
            <CaretakerGrantRow key={grant.grantToken} grant={grant} onOpen={onOpenCaretakerGrant} />
          ))}
        </View>
      )}

      <View style={styles.section}>
        <Eyebrow>Enviadas</Eyebrow>
        {outgoing.length === 0 ? (
          <EmptyState
            headline={emptyOutgoingLabel()}
            body="Podés ofrecer la titularidad de una mascota desde su ficha."
          />
        ) : (
          outgoing.map((transfer) => (
            <TransferRow key={transfer.transferToken} transfer={transfer} onOpen={onOpen} />
          ))
        )}
      </View>
    </Screen>
  );
}

/**
 * One proposal, as a row.
 *
 * The whole row is the target rather than a "Ver" link at its end, because a
 * phone's touch target should be the thing you are looking at. `accessibilityRole
 * ="button"` with a composed label, so a screen reader announces the animal, the
 * other party and the state as one sentence instead of reading three fragments.
 */
function TransferRow({
  transfer,
  onOpen,
}: {
  transfer: MyTransferV1;
  onOpen: (transferToken: string) => void;
}) {
  const counterparty = transferCounterpartyLabel(transfer);
  const deadline = transferDeadlineLabel(transfer);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        transfer.pet.name,
        counterparty,
        deadline ?? transferStatusLabel(transfer.status),
      ]
        .filter(Boolean)
        .join(". ")}
      onPress={() => onOpen(transfer.transferToken)}
      style={styles.row}
    >
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>{transfer.pet.name}</Text>
        {counterparty !== null && <Text style={styles.rowMeta}>{counterparty}</Text>}
        {/* Only while there IS a deadline. A resolved proposal's state is on the
            badge, and printing it here too said the same word twice. */}
        {deadline !== null && <Text style={styles.rowMeta}>{deadline}</Text>}
      </View>
      <Text style={styles.rowBadge}>{transferStatusLabel(transfer.status)}</Text>
    </Pressable>
  );
}

/**
 * One caretaker invitation or active arrangement, as a row.
 *
 * Mirrors `TransferRow`'s shape and touch-target rule for the same reason. The
 * badge always reads the row's OWN status — never a shared derived label — so a
 * screen reader announcing "Pendiente" or "Activo" says what the server decided,
 * not what this component guessed from a status string it does not own.
 */
function CaretakerGrantRow({
  grant,
  onOpen,
}: {
  grant: MyCaretakerGrantV1;
  onOpen: (grantToken: string) => void;
}) {
  const counterparty = caretakerCounterpartyLabel(grant);
  const period = caretakerPeriodLabel(grant);
  const badge = grant.status === "pending" ? "Pendiente" : "Activo";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[grant.pet.name, counterparty, period, badge].filter(Boolean).join(". ")}
      onPress={() => onOpen(grant.grantToken)}
      style={styles.row}
    >
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>{grant.pet.name}</Text>
        {counterparty !== null && <Text style={styles.rowMeta}>{counterparty}</Text>}
        <Text style={styles.rowMeta}>{period}</Text>
      </View>
      <Text style={styles.rowBadge}>{badge}</Text>
    </Pressable>
  );
}

/** Kept for the detail screen's "nothing here" case, which needs a Card shell. */
export function TransferMissingCard({ message }: { message: string }) {
  return (
    <Card>
      <Body>{message}</Body>
    </Card>
  );
}

const styles = StyleSheet.create({
  section: { gap: SPACE.sm, marginTop: SPACE.lg },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACE.sm,
    minHeight: TOUCH_TARGET,
    paddingVertical: SPACE.sm,
    paddingHorizontal: SPACE.md,
    borderRadius: RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  rowMain: { flex: 1, gap: SPACE.xs / 2 },
  rowTitle: {
    fontFamily: FONTS.serif,
    fontSize: TYPE.lg,
    lineHeight: TYPE.lg * LEADING.sm,
    color: COLORS.ink,
  },
  rowMeta: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.md,
    color: COLORS.inkMuted,
  },
  rowBadge: {
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * TRACKING.wider,
    textTransform: "uppercase",
    color: COLORS.inkMuted,
  },
});
