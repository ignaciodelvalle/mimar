// Mis casos — every open cycle plus the recent history (M11), the web's
// `/mis-mascotas#inbox` casos on a screen of their own.
//
// FOUR STATES, and the one that matters is that a FAILED read is never drawn as
// an empty one: "no tenés casos abiertos" over a pooler outage would hide an open
// bite observation from the person it binds. Once rows are on screen a failed
// refresh keeps them and says so (`reload-state.ts`).
//
// GROUPED like the web's Bandeja (PO 2026-10-06): "Te toca a vos", "En curso",
// and the history collapsed behind a toggle — one pet's cases gathered under
// the pet in each. The payload is normalized on arrival, so a server that
// predates the grouping still draws.

import type { MyCasesV1 } from "@dim/contract/api";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { apiFailureMessage } from "../api/client";
import { fetchMyCases } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body, Card, EmptyState, StaleNotice } from "../ui/components";
import { FONTS } from "../ui/fonts";
import {
  Callout,
  Eyebrow,
  Screen,
  SecondaryButton,
  Title,
  pressedOpacity,
  pullToRefresh,
} from "../ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../ui/reload-state";
import { ListSkeleton } from "../ui/skeleton";
import { COLORS, SPACE, TOUCH_TARGET, TYPE } from "../ui/theme";
import { useReconnect } from "../ui/use-reconnect";

import { CaseClusterList, OpenCaseGroups } from "./CaseGroups";
import { historyTruncationNote, normalizeMyCases } from "./cases-view-model";

type ScreenState =
  | { phase: "loading" }
  | ReadyState<MyCasesV1>
  | { phase: "failed"; message: string };

export function CasesScreen({ onOpenRoute }: { onOpenRoute: (route: string) => void }) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async (mode: "initial" | "refresh") => {
    const mine = ++generation.current;
    if (mode === "refresh") setRefreshing(true);
    else setState({ phase: "loading" });
    const result = await fetchMyCases(sessionPort);
    if (mine !== generation.current) return;
    setRefreshing(false);
    if (result.outcome === "ok") {
      setState(loaded(normalizeMyCases(result.payload)));
      return;
    }
    setState((current) =>
      reloadFailed(current, result, apiFailureMessage(result) ?? "No pudimos leer tus casos."),
    );
  }, []);

  // First focus reads; every later focus refreshes in place.
  const hasLoaded = useRef(false);
  useFocusEffect(
    useCallback(() => {
      void load(hasLoaded.current ? "refresh" : "initial");
      hasLoaded.current = true;
    }, [load]),
  );

  useReconnect(() => void load("refresh"));

  if (state.phase === "loading") {
    return (
      <Screen>
        <ListSkeleton rows={3} label="Cargando tus casos…" />
      </Screen>
    );
  }

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Mis casos</Title>
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load("initial")} />
      </Screen>
    );
  }

  const { open, history } = state.view;
  const truncation = historyTruncationNote(state.view);

  return (
    <Screen refreshControl={pullToRefresh(() => void load("refresh"), refreshing)}>
      <Title>Mis casos</Title>
      <Body>
        Todo lo que tenés en curso: denuncias, postulaciones, pérdidas y expedientes sobre tus
        mascotas.
      </Body>

      {state.staleFailure === null ? null : (
        <StaleNotice message={state.staleFailure} onRetry={() => void load("refresh")} />
      )}

      <View style={styles.section}>
        <Eyebrow>Casos abiertos</Eyebrow>
        {open.length === 0 ? (
          <EmptyState
            headline="Sin casos abiertos"
            body="Cualquier denuncia, postulación o pérdida que empieces va a aparecer acá."
          />
        ) : (
          <OpenCaseGroups rows={open} onOpenRoute={onOpenRoute} />
        )}
      </View>

      {/* Drawn only when it has rows — an empty "Historial" is furniture. Closed
          by default, like the web's <details>: what is done should not push
          what is open off the screen. */}
      {history.rows.length > 0 && (
        <View style={styles.section}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: historyOpen }}
            accessibilityLabel={`Historial, ${history.rows.length} ${history.rows.length === 1 ? "cerrado" : "cerrados"}`}
            onPress={() => setHistoryOpen((v) => !v)}
            style={(s) => [styles.toggle, pressedOpacity(s)]}
          >
            <Eyebrow>Historial</Eyebrow>
            <Text style={styles.toggleHint}>
              {historyOpen ? "Ocultar" : `Ver ${history.rows.length}`}
            </Text>
          </Pressable>
          {historyOpen ? (
            <>
              <CaseClusterList rows={history.rows} onOpenRoute={onOpenRoute} />
              {truncation === null ? null : (
                <Card>
                  <Body>{truncation}</Body>
                </Card>
              )}
            </>
          ) : null}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { gap: SPACE.sm, marginTop: SPACE.lg },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: TOUCH_TARGET,
  },
  toggleHint: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.accent },
});
