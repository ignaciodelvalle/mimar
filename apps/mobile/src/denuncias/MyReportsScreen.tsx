// Mis denuncias — the denuncias this person filed under their account, and the
// status of each, as the web's `/denuncias/mias` shows them (M16).
//
// ANONYMOUS ONES ARE NOT HERE, AND THE SCREEN SAYS SO. A denuncia filed
// anonymously is stored with no account attached — that is what the word
// promised — so no list can bring it back. Its author follows it with the code
// on the receipt. An empty list without that sentence would read as "we lost
// your denuncia" to exactly the person who chose anonymity.
//
// A FAILED READ IS NEVER DRAWN AS AN EMPTY ONE: "aún no enviaste denuncias" over
// a pooler outage would tell somebody their allegation was never recorded. Once
// rows are on screen a failed refresh keeps them and says so.
//
// PAGINATION IS "MOSTRAR MÁS", the adoption catalogue's pattern: the server's
// opaque cursor, appended, never replacing what is already on screen.

import type { MyWelfareReportRowV1, MyWelfareReportsV1 } from "@dim/contract/api";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { apiFailureMessage } from "../api/client";
import { fetchMyWelfareReports } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body, EmptyState, StaleNotice } from "../ui/components";
import { FONTS } from "../ui/fonts";
import {
  Callout,
  Screen,
  SecondaryButton,
  Subtitle,
  Title,
  pressedOpacity,
  pullToRefresh,
} from "../ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../ui/reload-state";
import { ListSkeleton } from "../ui/skeleton";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TYPE } from "../ui/theme";
import { useReconnect } from "../ui/use-reconnect";

import { StatusBadge } from "./StatusBadge";
import {
  myReportsSummary,
  reportDateLabel,
  reportRowAccessibilityLabel,
} from "./my-reports-view-model";

type Page = { reports: MyWelfareReportRowV1[]; nextCursor: string | null };

type ScreenState = { phase: "loading" } | ReadyState<Page> | { phase: "failed"; message: string };

const FAILED_READ = "No pudimos leer tus denuncias.";

export function MyReportsScreen({
  onOpenReport,
  onNewReport,
}: {
  onOpenReport: (referenceCode: string) => void;
  onNewReport: () => void;
}) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Why the LAST "Mostrar más" produced nothing — a page that did not arrive is not the end. */
  const [moreFailure, setMoreFailure] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async (mode: "initial" | "refresh") => {
    const mine = ++generation.current;
    if (mode === "refresh") setRefreshing(true);
    else setState({ phase: "loading" });
    setMoreFailure(null);
    const result = await fetchMyWelfareReports(sessionPort);
    if (mine !== generation.current) return;
    setRefreshing(false);
    if (result.outcome === "ok") {
      setState(loaded(pageOf(result.payload)));
      return;
    }
    setState((current) => reloadFailed(current, result, apiFailureMessage(result) ?? FAILED_READ));
  }, []);

  // First focus reads; every later focus refreshes in place — an authority may
  // have moved a status while the person was on the detail screen.
  const hasLoaded = useRef(false);
  useFocusEffect(
    useCallback(() => {
      void load(hasLoaded.current ? "refresh" : "initial");
      hasLoaded.current = true;
    }, [load]),
  );

  useReconnect(() => void load("refresh"));

  const onMore = useCallback(async () => {
    if (state.phase !== "ready" || state.view.nextCursor === null) return;
    setLoadingMore(true);
    setMoreFailure(null);
    const mine = ++generation.current;
    const result = await fetchMyWelfareReports(sessionPort, state.view.nextCursor);
    if (mine !== generation.current) {
      setLoadingMore(false);
      return;
    }
    if (result.outcome === "ok") {
      // APPENDED, never replaced.
      setState((prev) =>
        prev.phase === "ready"
          ? {
              ...prev,
              view: {
                reports: [...prev.view.reports, ...result.payload.reports],
                nextCursor: result.payload.nextCursor,
              },
            }
          : prev,
      );
    } else {
      setMoreFailure(apiFailureMessage(result) ?? "No pudimos traer más denuncias.");
    }
    setLoadingMore(false);
  }, [state]);

  if (state.phase === "loading") {
    return (
      <Screen>
        <ListSkeleton rows={3} label="Cargando tus denuncias…" />
      </Screen>
    );
  }

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Mis denuncias</Title>
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load("initial")} />
      </Screen>
    );
  }

  const { reports, nextCursor } = state.view;

  return (
    <Screen refreshControl={pullToRefresh(() => void load("refresh"), refreshing)}>
      <Title>Mis denuncias</Title>
      <Subtitle>{myReportsSummary(reports.length, nextCursor !== null)}</Subtitle>

      {state.staleFailure === null ? null : (
        <StaleNotice message={state.staleFailure} onRetry={() => void load("refresh")} />
      )}

      {reports.length === 0 ? (
        <EmptyState
          headline="Aún no enviaste denuncias."
          body="Podés reportar maltrato, abandono u otras situaciones de riesgo para animales."
          actionLabel="Nueva denuncia"
          onAction={onNewReport}
        />
      ) : (
        <View style={styles.list}>
          {reports.map((row) => (
            <ReportRow
              key={row.referenceCode}
              row={row}
              onPress={() => onOpenReport(row.referenceCode)}
            />
          ))}
        </View>
      )}

      {moreFailure === null ? null : <StaleNotice message={moreFailure} />}
      {nextCursor === null ? null : (
        <SecondaryButton
          label={loadingMore ? "Cargando…" : "Mostrar más"}
          disabled={loadingMore}
          onPress={() => void onMore()}
        />
      )}

      <Callout tone="neutral" title="¿Enviaste una denuncia anónima?">
        <Body>
          Las denuncias anónimas no quedan vinculadas a tu cuenta, por eso no aparecen acá. Se
          siguen con el código que te dimos al enviarlas.
        </Body>
      </Callout>

      {reports.length === 0 ? null : (
        <SecondaryButton label="Nueva denuncia" onPress={onNewReport} />
      )}
    </Screen>
  );
}

function pageOf(payload: MyWelfareReportsV1): Page {
  return { reports: payload.reports, nextCursor: payload.nextCursor };
}

function ReportRow({ row, onPress }: { row: MyWelfareReportRowV1; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={reportRowAccessibilityLabel(row)}
      onPress={onPress}
      style={(state) => [styles.row, pressedOpacity(state)]}
    >
      <View style={styles.rowHead}>
        <Text style={styles.kind}>{row.kindLabel}</Text>
        <StatusBadge status={row.status} label={row.statusLabel} />
      </View>
      <Text style={styles.meta}>{`${row.severityLabel} · ${row.referenceCode}`}</Text>
      <Text numberOfLines={2} style={styles.excerpt}>
        {row.excerpt}
      </Text>
      <Text style={styles.meta}>
        {[reportDateLabel(row.filedAt), row.place].filter(Boolean).join(" · ")}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { gap: SPACE.sm },
  row: {
    minHeight: TOUCH_TARGET,
    gap: SPACE.xs,
    padding: SPACE.md,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.control,
    backgroundColor: COLORS.surface,
  },
  rowHead: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: SPACE.sm,
  },
  kind: {
    flex: 1,
    fontFamily: FONTS.serif,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.sm,
    color: COLORS.ink,
  },
  meta: { fontFamily: FONTS.mono, fontSize: TYPE.xs, color: COLORS.inkMuted },
  excerpt: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.inkSoft,
  },
});
