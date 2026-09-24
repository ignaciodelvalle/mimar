// MIS POSTULACIONES.
//
// THE FOURTH SCREEN IN THIS APP THAT IS NOT ABOUT A PET THIS PERSON HOLDS, and
// the one where that is most nearly the definition: somebody with postulaciones
// has no pet YET. It sits under `/adoptar` rather than under `/mascotas` for
// exactly that reason, even though the web files it the other way.
//
// D17 IS ENFORCED BY WHAT IS ABSENT AND THIS SCREEN MUST NOT INVENT IT. There is
// nothing in the payload about how many other people applied, who they are, or
// where this application sits in a queue — and there is no honest way to derive
// one from the status either. "En revisión" says what the shelter is doing, not
// where the reader stands in a line.
//
// THE FICHA LINK COMES FROM `stillListed`, NEVER FROM THE STATUS. A `pending`
// application over an animal the shelter unpublished this morning would open a
// 404 — or worse, a "ya encontró su hogar" for an animal this person is still
// waiting on.
//
// NO "RETIRAR", AND IT IS A GAP RATHER THAN A DECISION. The web has
// `WithdrawApplicationButton` over `withdrawAdoptionApplicationAction`; there is
// no bearer door for it yet, so this screen reads and does not act. It is on the
// board.

import type { MyAdoptionApplicationV1, MyAdoptionApplicationsV1 } from "@dim/contract/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";

import { apiFailureMessage } from "../api/client";
import { fetchMyAdoptionApplications } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body, EmptyState, ErrorNotice, StaleNotice } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { Screen, Subtitle, Title } from "../ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../ui/reload-state";
import { ListSkeleton } from "../ui/skeleton";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TRACKING, TYPE } from "../ui/theme";
import { useReconnect } from "../ui/use-reconnect";

import {
  APPLICATIONS_EMPTY,
  applicationFichaAvailable,
  applicationStatusBody,
  applicationStatusLabel,
  applicationsTruncationNote,
} from "./adoption-view-model";

type ScreenState =
  | { phase: "loading" }
  | ReadyState<MyAdoptionApplicationsV1>
  | { phase: "failed"; message: string };

/**
 * es-AR short date. `Intl` is available in Hermes with the `intl` variant this
 * app already ships (the fee line in the ficha relies on `toLocaleString` for
 * the same reason), and a hand-rolled `DD/MM` would be a second date format in
 * an app that already has one.
 */
function shortDate(iso: string): string {
  const value = new Date(iso);
  return Number.isNaN(value.getTime())
    ? "—"
    : value.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function MyApplicationsScreen({
  onOpenFicha,
  onBrowse,
}: {
  onOpenFicha: (petToken: string) => void;
  onBrowse: () => void;
}) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    const result = await fetchMyAdoptionApplications(sessionPort);
    if (generation.current !== mine) return;
    if (result.outcome === "ok") {
      setState(loaded(result.payload));
      return;
    }
    // NOT AN EMPTY LIST. The server answers 503 for a read it could not finish,
    // and "todavía no te postulaste" over that tells somebody waiting on a
    // shelter's answer that they never asked.
    //
    // AND NOT AN EMPTY SCREEN either, once there are rows (S-2): a pull-to-
    // refresh in a dead spot must not delete the answer a shelter already gave.
    setState((current) =>
      reloadFailed(current, result, apiFailureMessage(result) ?? "No pudimos cargar."),
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // WHEN THE NETWORK COMES BACK, TRY AGAIN (B-05, the other half of S-2). `load`
  // never blanks the list — only the initial state does — so this is safe to
  // fire unprompted: whatever is on screen stays there while it happens.
  useReconnect(() => void load());

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (state.phase === "loading") {
    return (
      <Screen>
        <ListSkeleton rows={3} label="Buscando tus postulaciones…" />
      </Screen>
    );
  }

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Mis postulaciones</Title>
        <ErrorNotice message={state.message} onRetry={() => void load()} />
      </Screen>
    );
  }

  const { applications, truncated } = state.view;
  const note = applicationsTruncationNote(truncated);

  return (
    <Screen
      refreshControl={
        // TINTED, like every other pull-to-refresh in this app (STATES-M4). The
        // platform default is a grey that reads as chrome from another app on a
        // cream page — /mascotas, notificaciones, turnos and transferencias all
        // pass the accent, and this was the one that did not.
        <RefreshControl
          colors={[COLORS.accent]}
          onRefresh={() => void onRefresh()}
          refreshing={refreshing}
          tintColor={COLORS.accent}
        />
      }
    >
      <Title>Mis postulaciones</Title>
      <Subtitle>
        Acá ves el estado de tus postulaciones. El refugio te contacta por email cuando avanza.
      </Subtitle>

      {state.staleFailure === null ? null : (
        <StaleNotice message={state.staleFailure} onRetry={() => void onRefresh()} />
      )}

      {applications.length === 0 ? (
        <EmptyState
          headline={APPLICATIONS_EMPTY.title}
          body={APPLICATIONS_EMPTY.body}
          actionLabel="Ver mascotas en adopción"
          onAction={onBrowse}
        />
      ) : (
        <>
          {applications.map((app) => (
            <ApplicationRow
              key={app.applicationId}
              app={app}
              onOpenFicha={() => onOpenFicha(app.petToken)}
            />
          ))}
          {note === null ? null : <Body>{note}</Body>}
        </>
      )}
    </Screen>
  );
}

function ApplicationRow({
  app,
  onOpenFicha,
}: {
  app: MyAdoptionApplicationV1;
  onOpenFicha: () => void;
}) {
  const linkable = applicationFichaAvailable(app);
  const content = (
    <>
      <View style={styles.head}>
        <Text style={styles.petName}>{app.petName}</Text>
        <Text style={styles.status}>{applicationStatusLabel(app.status)}</Text>
      </View>
      <Text style={styles.meta}>Refugio: {app.orgName}</Text>
      <Text style={styles.meta}>
        Enviada el {shortDate(app.submittedAt)}
        {app.decisionAt === null ? "" : ` · Última actualización: ${shortDate(app.decisionAt)}`}
      </Text>
      <Text style={styles.body}>{applicationStatusBody(app)}</Text>
    </>
  );

  // A ROW THAT CANNOT OPEN ANYTHING IS NOT A BUTTON. Wrapping every row in a
  // Pressable would announce a control to a screen reader for an animal whose
  // ficha no longer resolves — the same tap that would land on a 404.
  return linkable ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Ver la ficha de ${app.petName}`}
      onPress={onOpenFicha}
      style={styles.row}
    >
      {content}
    </Pressable>
  ) : (
    <View style={styles.row}>{content}</View>
  );
}

const styles = StyleSheet.create({
  row: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.control,
    backgroundColor: COLORS.surface,
    padding: SPACE.md,
    gap: SPACE.xs,
    minHeight: TOUCH_TARGET,
  },
  head: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: SPACE.sm,
  },
  petName: {
    fontFamily: FONTS.serif,
    fontSize: TYPE.lg,
    color: COLORS.ink,
  },
  status: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.xs,
    color: COLORS.inkMuted,
    letterSpacing: TRACKING.wide,
  },
  meta: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.sm,
    color: COLORS.inkMuted,
  },
  body: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.md,
    color: COLORS.inkSoft,
    lineHeight: TYPE.md * LEADING.md,
  },
});
