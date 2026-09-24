// Mis casos — every open cycle plus the recent history (M11), the web's
// `/mis-mascotas#inbox` "Casos abiertos" and "Historial" on a screen of their own.
//
// FOUR STATES, and the one that matters is that a FAILED read is never drawn as
// an empty one: "no tenés casos abiertos" over a pooler outage would hide an open
// bite observation from the person it binds. Once rows are on screen a failed
// refresh keeps them and says so (`reload-state.ts`).

import type { MyCasesV1 } from "@dim/contract/api";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { apiFailureMessage } from "../api/client";
import { fetchMyCases } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body, Card, EmptyState, StaleNotice } from "../ui/components";
import { Callout, Eyebrow, Screen, SecondaryButton, Title, pullToRefresh } from "../ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../ui/reload-state";
import { ListSkeleton } from "../ui/skeleton";
import { SPACE } from "../ui/theme";
import { useReconnect } from "../ui/use-reconnect";

import { CaseRow } from "./CaseRow";
import { historyTruncationNote } from "./cases-view-model";

type ScreenState =
  | { phase: "loading" }
  | ReadyState<MyCasesV1>
  | { phase: "failed"; message: string };

export function CasesScreen({ onOpenRoute }: { onOpenRoute: (route: string) => void }) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async (mode: "initial" | "refresh") => {
    const mine = ++generation.current;
    if (mode === "refresh") setRefreshing(true);
    else setState({ phase: "loading" });
    const result = await fetchMyCases(sessionPort);
    if (mine !== generation.current) return;
    setRefreshing(false);
    if (result.outcome === "ok") {
      setState(loaded(result.payload));
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
          open.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: no id crosses the wire; see the contract
            <CaseRow key={index} row={row} onOpenRoute={onOpenRoute} />
          ))
        )}
      </View>

      {/* Drawn only when it has rows — an empty "Historial" is furniture. */}
      {history.rows.length > 0 && (
        <View style={styles.section}>
          <Eyebrow>Historial</Eyebrow>
          {history.rows.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: no id crosses the wire; see the contract
            <CaseRow key={index} row={row} onOpenRoute={onOpenRoute} />
          ))}
          {truncation === null ? null : (
            <Card>
              <Body>{truncation}</Body>
            </Card>
          )}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { gap: SPACE.sm, marginTop: SPACE.lg },
});
