// One case — the web's `/casos/{publicCode}`, as a signed-in person sees it (M11).
//
// THE SERVER DECIDES EVERYTHING ON THIS SCREEN. Whether the person may read the
// case at all is `readCaseForViewer`, the same function the web page runs; what
// each line says is the web's own words, pre-rendered in the payload. The screen
// draws, and it draws three answers honestly:
//
//   · `access: "full"` — the case.
//   · `access: "caretaker_only"` — the pet's live caretaker. Cases are
//     titular-only, and this says so in the web's words instead of pretending
//     the case does not exist.
//   · `not_found` — no such case, or one this person may not read. The two are
//     deliberately the same answer on the wire, so they are the same sentence
//     here.

import type { MyCaseDetailV1, MyCaseReadableV1 } from "@dim/contract/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { type ApiResult, apiFailureMessage } from "../api/client";
import { fetchMyCase } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body, Card, Row, StaleNotice } from "../ui/components";
import { FONTS } from "../ui/fonts";
import {
  Callout,
  Eyebrow,
  LinkText,
  Screen,
  SecondaryButton,
  Subtitle,
  Title,
  pullToRefresh,
} from "../ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../ui/reload-state";
import { ListSkeleton } from "../ui/skeleton";
import { COLORS, LEADING, SPACE, TYPE } from "../ui/theme";
import { useReconnect } from "../ui/use-reconnect";

import { caseDateLabel, caseDateTimeLabel } from "./cases-view-model";

type ScreenState =
  | { phase: "loading" }
  | ReadyState<MyCaseDetailV1>
  | { phase: "failed"; message: string };

/**
 * The failure sentence. ONE override: `not_found` gets a sentence about a CASE,
 * because the shared copy for that code is written for a credential lookup.
 * Every other outcome is `apiFailureMessage`'s, correlation code included.
 */
export function caseFailureMessage(result: ApiResult<unknown>): string {
  if (result.outcome === "api-error" && result.code === "not_found") {
    return "No encontramos este caso, o no está en tu cuenta.";
  }
  return apiFailureMessage(result) ?? "No pudimos leer el caso.";
}

export function CaseDetailScreen({
  publicCode,
  onOpenRoute,
}: {
  publicCode: string;
  onOpenRoute: (route: string) => void;
}) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);

  const load = useCallback(
    async (mode: "initial" | "refresh") => {
      const mine = ++generation.current;
      if (mode === "refresh") setRefreshing(true);
      else setState({ phase: "loading" });
      const result = await fetchMyCase(publicCode, sessionPort);
      if (mine !== generation.current) return;
      setRefreshing(false);
      if (result.outcome === "ok") {
        setState(loaded(result.payload));
        return;
      }
      setState((current) => reloadFailed(current, result, caseFailureMessage(result)));
    },
    [publicCode],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  useReconnect(() => void load("refresh"));

  if (state.phase === "loading") {
    return (
      <Screen>
        <ListSkeleton rows={3} label="Cargando el caso…" />
      </Screen>
    );
  }

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Caso</Title>
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load("initial")} />
      </Screen>
    );
  }

  const view = state.view;
  const refresher = pullToRefresh(() => void load("refresh"), refreshing);
  const stale =
    state.staleFailure === null ? null : (
      <StaleNotice message={state.staleFailure} onRetry={() => void load("refresh")} />
    );

  if (view.access === "caretaker_only") {
    const pet = view.pet;
    return (
      <Screen refreshControl={refresher}>
        {stale}
        {/* The web's own phrase (`CaseNotForCaretaker`): it names the ROLE, so
            this reads as a boundary that applies to the person, not an error. */}
        <Callout tone="warn" title="Caso no disponible para cuidadores">
          <Body>
            El expediente lo sigue el titular de la mascota, que es quien puede verlo y responder.
            Vos podés seguir cargando eventos médicos, notas y marcar perdido/encontrado mientras
            dure el cuidado.
          </Body>
        </Callout>
        {pet === null || pet.route === null ? null : (
          <LinkText onPress={() => onOpenRoute(pet.route as string)}>Volver a {pet.name}</LinkText>
        )}
      </Screen>
    );
  }

  return (
    <Screen refreshControl={refresher}>
      {stale}
      <CaseBody view={view} onOpenRoute={onOpenRoute} />
    </Screen>
  );
}

function CaseBody({
  view,
  onOpenRoute,
}: {
  view: MyCaseReadableV1;
  onOpenRoute: (route: string) => void;
}) {
  const { subject } = view;
  const dates = [
    `Abierto el ${caseDateLabel(view.openedAt)}`,
    view.closedAt === null ? null : `Cerrado el ${caseDateLabel(view.closedAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <Eyebrow>{`${view.publicCode} · ${view.statusLabel}`}</Eyebrow>
      <Title>{view.kindLabel}</Title>
      <Subtitle>{dates}</Subtitle>

      <Card title="Sujeto">
        {subject.kind === "pet" ? (
          <>
            <Text style={styles.subjectName}>{subject.name}</Text>
            <Body>{subject.speciesLine}</Body>
            {subject.route === null ? null : (
              <LinkText onPress={() => onOpenRoute(subject.route as string)}>Ver mascota</LinkText>
            )}
          </>
        ) : (
          <Body>{subject.description}</Body>
        )}
      </Card>

      <Card>
        <Row label="Jurisdicción" value={view.jurisdiction ?? "Sin especificar"} />
        {view.parties.map((party, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a short, fixed-order list
          <Row key={index} label={party.roleLabel} value={party.name ?? "—"} />
        ))}
      </Card>

      {view.openedReason === null ? null : (
        <Card title="Motivo de apertura">
          <Body>{view.openedReason}</Body>
        </Card>
      )}

      {view.normatives.length === 0 ? null : (
        <Card title="Normativa aplicable">
          {view.normatives.map((law, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a short, fixed-order list
            <View key={index} style={styles.law}>
              <Text style={styles.lawLabel}>{law.label}</Text>
              <Body>{law.scope}</Body>
            </View>
          ))}
        </Card>
      )}

      <View style={styles.section}>
        <Eyebrow>Línea de tiempo</Eyebrow>
        {view.timeline.length === 0 ? (
          <Body>Todavía no hay eventos registrados en este caso.</Body>
        ) : (
          view.timeline.map((entry, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: entries carry no id on the wire
            <View key={index} style={styles.entry}>
              <Text style={styles.entryLabel}>{entry.label}</Text>
              <Text style={styles.entryDate}>{caseDateTimeLabel(entry.occurredAt)}</Text>
              {entry.summary === null ? null : <Body>{entry.summary}</Body>}
              {entry.notes === null ? null : <Body selectable>{entry.notes}</Body>}
            </View>
          ))
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  section: { gap: SPACE.sm, marginTop: SPACE.lg },
  subjectName: {
    fontFamily: FONTS.serif,
    fontSize: TYPE.lg,
    lineHeight: TYPE.lg * LEADING.sm,
    color: COLORS.ink,
  },
  law: { gap: SPACE.xs / 2 },
  lawLabel: { fontFamily: FONTS.sansSemibold, fontSize: TYPE.md, color: COLORS.ink },
  entry: {
    gap: SPACE.xs / 2,
    paddingVertical: SPACE.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  entryLabel: { fontFamily: FONTS.sansSemibold, fontSize: TYPE.md, color: COLORS.ink },
  entryDate: { fontFamily: FONTS.mono, fontSize: TYPE.sm, color: COLORS.inkMuted },
});
