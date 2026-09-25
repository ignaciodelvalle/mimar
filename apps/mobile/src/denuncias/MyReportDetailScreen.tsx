// One denuncia, as the web's `/denuncias/{id}` shows it to its author (M16).
//
// THE SERVER DECIDES EVERYTHING ON THIS SCREEN. Whether this person may read
// the denuncia is the reader the web page runs; the status words and the
// banner under them are the web's own, pre-rendered in the payload
// (`welfareReportReporterNotice`). The screen draws.
//
// NOT FOUND IS ONE SENTENCE for three cases the server deliberately does not
// tell apart: somebody else's denuncia, an anonymous one, and a code that does
// not exist.
//
// WHAT THE WEB PAGE HAS AND THIS DOES NOT, said rather than left silent: the
// map (a native module, an EAS build — the coordinates are printed instead, as
// the web prints them under its map) and the form to add a comment to the case
// (a write this read-only door does not carry; the web page still has it).

import type { MyWelfareReportDetailV1 } from "@dim/contract/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image, Linking, Pressable, StyleSheet, Text, View } from "react-native";

import { fetchMyWelfareReport } from "../api/endpoints";
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
import { COLORS, LEADING, RADIUS, SPACE, TYPE } from "../ui/theme";
import { useReconnect } from "../ui/use-reconnect";

import { StatusBadge } from "./StatusBadge";
import { myReportFailureMessage, reportDateLabel } from "./my-reports-view-model";

type ScreenState =
  | { phase: "loading" }
  | ReadyState<MyWelfareReportDetailV1>
  | { phase: "failed"; message: string };

const THUMB_SIZE = 96;

export function MyReportDetailScreen({
  referenceCode,
  onOpenRoute,
}: {
  referenceCode: string;
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
      const result = await fetchMyWelfareReport(referenceCode, sessionPort);
      if (mine !== generation.current) return;
      setRefreshing(false);
      if (result.outcome === "ok") {
        setState(loaded(result.payload));
        return;
      }
      setState((current) => reloadFailed(current, result, myReportFailureMessage(result)));
    },
    [referenceCode],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  useReconnect(() => void load("refresh"));

  if (state.phase === "loading") {
    return (
      <Screen>
        <ListSkeleton rows={3} label="Cargando la denuncia…" />
      </Screen>
    );
  }

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Denuncia</Title>
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load("initial")} />
      </Screen>
    );
  }

  const view = state.view;
  const caseLink = view.case;

  return (
    <Screen refreshControl={pullToRefresh(() => void load("refresh"), refreshing)}>
      {state.staleFailure === null ? null : (
        <StaleNotice message={state.staleFailure} onRetry={() => void load("refresh")} />
      )}

      <Eyebrow>{`Código ${view.referenceCode}`}</Eyebrow>
      <Title>{view.kindLabel}</Title>
      <View style={styles.badges}>
        <StatusBadge status={view.status} label={view.statusLabel} />
        <Text style={styles.severity}>{view.severityLabel}</Text>
      </View>
      <Subtitle>
        {[
          `Enviada el ${reportDateLabel(view.filedAt)}`,
          view.occurredAt === null ? null : `Ocurrió el ${reportDateLabel(view.occurredAt)}`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </Subtitle>

      {view.notice === null ? null : (
        <Callout tone={view.notice.tone === "warn" ? "warn" : "neutral"}>
          <Body>{view.notice.text}</Body>
        </Callout>
      )}

      {caseLink === null ? null : caseLink.route === null ? (
        <Body>{`Caso ${caseLink.publicCode}`}</Body>
      ) : (
        <LinkText onPress={() => onOpenRoute(caseLink.route as string)}>
          {`Ver caso ${caseLink.publicCode}`}
        </LinkText>
      )}

      <Card title="¿Qué pasó?">
        <Body selectable>{view.description}</Body>
      </Card>

      <SubjectCard subject={view.subject} />
      {view.place === null ? null : <PlaceCard place={view.place} />}
      {view.contact === null ? null : <ContactCard contact={view.contact} />}
      {view.evidence.length === 0 ? null : <EvidenceCard evidence={view.evidence} />}

      {view.comments.length === 0 ? null : (
        <Card title="Tus comentarios sobre el caso">
          {view.comments.map((comment, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: comments carry no id on the wire
            <View key={index} style={styles.comment}>
              <Body selectable>{comment.text}</Body>
              <Text style={styles.mono}>{reportDateLabel(comment.at)}</Text>
            </View>
          ))}
        </Card>
      )}

      <LinkText
        accessibilityHint="Se abre en el navegador"
        onPress={() => void Linking.openURL(view.constanciaUrl)}
      >
        Ver la constancia en la web
      </LinkText>
    </Screen>
  );
}

type Detail = MyWelfareReportDetailV1;

function SubjectCard({ subject }: { subject: Detail["subject"] }) {
  return (
    <Card title="¿Sobre quién?">
      <Body>{subject.label}</Body>
      {subject.pet === null ? null : (
        <Text style={styles.pet}>{`${subject.pet.name} · ${subject.pet.publicToken}`}</Text>
      )}
      {subject.description === null ? null : <Body>{subject.description}</Body>}
    </Card>
  );
}

function PlaceCard({ place }: { place: NonNullable<Detail["place"]> }) {
  return (
    <Card title="Lugar">
      {place.address === null ? null : <Body>{place.address}</Body>}
      {place.jurisdiction === null ? null : <Text style={styles.mono}>{place.jurisdiction}</Text>}
      {place.point === null ? null : (
        <Text selectable style={styles.mono}>
          {`${place.point.lat.toFixed(6)}, ${place.point.lng.toFixed(6)}`}
        </Text>
      )}
    </Card>
  );
}

function ContactCard({ contact }: { contact: NonNullable<Detail["contact"]> }) {
  return (
    <Card title="Contacto que dejaste">
      {contact.email === null ? null : <Row label="Correo" value={contact.email} />}
      {contact.phone === null ? null : <Row label="Teléfono" value={contact.phone} />}
    </Card>
  );
}

function EvidenceCard({ evidence }: { evidence: Detail["evidence"] }) {
  return (
    <Card title="Evidencia adjunta">
      <View style={styles.evidence}>
        {evidence.map((item, index) =>
          item.kind === "image" ? (
            <Pressable
              // biome-ignore lint/suspicious/noArrayIndexKey: evidence carries no id on the wire
              key={index}
              accessibilityRole="imagebutton"
              accessibilityLabel={item.filename ?? "Evidencia adjunta"}
              accessibilityHint="Se abre en el navegador"
              onPress={() => void Linking.openURL(item.url)}
            >
              <Image source={{ uri: item.url }} style={styles.thumb} />
            </Pressable>
          ) : (
            <LinkText
              // biome-ignore lint/suspicious/noArrayIndexKey: evidence carries no id on the wire
              key={index}
              accessibilityHint="Se abre en el navegador"
              onPress={() => void Linking.openURL(item.url)}
            >
              {item.filename === null ? "Ver video" : `Ver video (${item.filename})`}
            </LinkText>
          ),
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  badges: { flexDirection: "row", alignItems: "center", gap: SPACE.sm, flexWrap: "wrap" },
  severity: { fontFamily: FONTS.mono, fontSize: TYPE.xs, color: COLORS.inkMuted },
  pet: {
    fontFamily: FONTS.sansMedium,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.ink,
  },
  mono: { fontFamily: FONTS.mono, fontSize: TYPE.sm, color: COLORS.inkMuted },
  evidence: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.sm },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: RADIUS.control,
    backgroundColor: COLORS.stripe,
  },
  comment: {
    gap: SPACE.xs / 2,
    paddingVertical: SPACE.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
});
