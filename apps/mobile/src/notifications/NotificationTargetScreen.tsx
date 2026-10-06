// AVISO — where one notification leads, asked of the server at tap time
// (notificaciones-destinos, 2026-10).
//
// THE ONE DOOR. A push tap that carries `notificationId` and every inbox CTA open
// this screen. It asks `GET /api/v1/me/notifications/{id}/target` and:
//
//   · REPLACES itself with the resolved screen — the case, the pet, a section the
//     app has — so the back gesture returns to wherever the tap came from;
//   · OPENS an outside link (an official information page the writer linked)
//     in the browser, and stays, so coming back lands on the explanation;
//   · or STAYS and explains: the case or the pet is gone for this reader (the
//     transfer was accepted, the membership ended, the custody episode closed),
//     or the destination exists only on the web. It says why, who has to act
//     when something is pending, and offers the browser for a web-only one.
//
// What it never does is what the app used to: push a stored web path onto a
// screen that then answered "No disponible", or draw the CTA as grey text that
// said "abrilo desde la web".
//
// ONE READ PER NOTIFICATION (code review R10). The callbacks arrive as fresh
// closures on every parent render; holding them in refs keeps the effect keyed
// on `notificationId` alone, so a re-render never fetches — or replaces — twice.

import type { NotificationTargetV1 } from "@dim/contract/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { apiFailureMessage } from "../api/client";
import { fetchNotificationTarget } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body, ErrorNotice, Loading } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { Callout, PrimaryButton, Screen, SecondaryButton, Title } from "../ui/kit";
import { COLORS, LEADING, SPACE, TYPE } from "../ui/theme";

import { targetFailure, targetStep } from "./notification-target-view-model";

type State =
  | { phase: "loading" }
  | { phase: "explain"; target: NotificationTargetV1; externalUrl: string | null }
  | { phase: "failed"; message: string; retry: boolean };

export function NotificationTargetScreen({
  notificationId,
  onReplace,
  onOpenWeb,
  onOpenExternal,
  onOpenInbox,
}: {
  notificationId: string;
  /** Replace THIS screen with the resolved in-app route. */
  onReplace: (route: string) => void;
  /** Open a web path in the browser (a destination the app has no screen for). */
  onOpenWeb: (target: NotificationTargetV1) => void;
  /** Open an outside address (validated http(s)) in the browser. */
  onOpenExternal: (url: string) => void;
  /** The way back to the inbox. */
  onOpenInbox: () => void;
}) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const generation = useRef(0);
  const onReplaceRef = useRef(onReplace);
  const onOpenExternalRef = useRef(onOpenExternal);
  onReplaceRef.current = onReplace;
  onOpenExternalRef.current = onOpenExternal;

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setState({ phase: "loading" });
    const result = await fetchNotificationTarget(sessionPort, notificationId);
    if (mine !== generation.current) return;
    if (result.outcome !== "ok") {
      const failure = targetFailure(result);
      setState({
        phase: "failed",
        message:
          failure?.message ?? apiFailureMessage(result) ?? "No pudimos abrir esta notificación.",
        retry: failure?.retry ?? true,
      });
      return;
    }
    const step = targetStep(result.payload);
    if (step.kind === "go") {
      onReplaceRef.current(step.route);
      return;
    }
    if (step.kind === "external") {
      onOpenExternalRef.current(step.url);
      setState({ phase: "explain", target: step.target, externalUrl: step.url });
      return;
    }
    setState({ phase: "explain", target: step.target, externalUrl: null });
  }, [notificationId]);

  useEffect(() => {
    void load();
    return () => {
      // A late answer must not replace a screen the person already left.
      generation.current++;
    };
  }, [load]);

  if (state.phase === "loading") {
    return (
      <Screen>
        <Loading label="Abriendo la notificación…" />
      </Screen>
    );
  }

  if (state.phase === "failed") {
    return (
      <Screen>
        <ErrorNotice
          message={state.message}
          onRetry={state.retry ? () => void load() : undefined}
        />
        <SecondaryButton label="Ir a notificaciones" onPress={onOpenInbox} />
      </Screen>
    );
  }

  const { target, externalUrl } = state;
  return (
    <Screen>
      <View style={styles.head}>
        <Title>{target.title}</Title>
        {target.body !== null && <Body>{target.body}</Body>}
      </View>

      {target.reasonCopy !== null && (
        <Callout tone={target.webOnly || externalUrl !== null ? "neutral" : "warn"}>
          <Body>{target.reasonCopy}</Body>
        </Callout>
      )}

      {target.actorCopy !== null && (
        <Text style={styles.actor} accessibilityRole="text">
          {target.actorCopy}
        </Text>
      )}

      {externalUrl !== null && (
        <PrimaryButton
          label={target.externalLabel ?? "Abrir enlace"}
          onPress={() => onOpenExternal(externalUrl)}
        />
      )}
      {target.webOnly && (
        <PrimaryButton label="Abrir en el navegador" onPress={() => onOpenWeb(target)} />
      )}
      <SecondaryButton label="Ir a notificaciones" onPress={onOpenInbox} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { gap: SPACE.xs },
  actor: {
    fontFamily: FONTS.sansMedium,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.ink,
  },
});
