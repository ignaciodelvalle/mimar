// AVISO — where one notification leads, asked of the server at tap time
// (notificaciones-destinos, 2026-10).
//
// THE ONE DOOR. A push tap that carries `notificationId` and every inbox CTA open
// this screen. It asks `GET /api/v1/me/notifications/{id}/target` and:
//
//   · REPLACES itself with the resolved screen — the case, the pet, a section the
//     app has — so the back gesture returns to wherever the tap came from;
//   · or STAYS and explains: the case or the pet is gone for this reader (the
//     transfer was accepted, the membership ended, the custody episode closed),
//     or the destination exists only on the web. It says why, who has to act
//     when something is pending, and offers the browser for a web-only one.
//
// What it never does is what the app used to: push a stored web path onto a
// screen that then answered "No disponible", or draw the CTA as grey text that
// said "abrilo desde la web".

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

import { targetFailureMessage, targetStep } from "./notification-target-view-model";

type State =
  | { phase: "loading" }
  | { phase: "explain"; target: NotificationTargetV1 }
  | { phase: "failed"; message: string };

export function NotificationTargetScreen({
  notificationId,
  onReplace,
  onOpenWeb,
  onOpenInbox,
}: {
  notificationId: string;
  /** Replace THIS screen with the resolved in-app route. */
  onReplace: (route: string) => void;
  /** Open a web path in the browser (a destination the app has no screen for). */
  onOpenWeb: (target: NotificationTargetV1) => void;
  /** The way back to the inbox. */
  onOpenInbox: () => void;
}) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setState({ phase: "loading" });
    const result = await fetchNotificationTarget(sessionPort, notificationId);
    if (mine !== generation.current) return;
    if (result.outcome !== "ok") {
      setState({
        phase: "failed",
        message:
          targetFailureMessage(result) ??
          apiFailureMessage(result) ??
          "No pudimos abrir esta notificación.",
      });
      return;
    }
    const step = targetStep(result.payload);
    if (step.kind === "go") {
      onReplace(step.route);
      return;
    }
    setState({ phase: "explain", target: step.target });
  }, [notificationId, onReplace]);

  useEffect(() => {
    void load();
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
        <ErrorNotice message={state.message} onRetry={() => void load()} />
        <SecondaryButton label="Ir a notificaciones" onPress={onOpenInbox} />
      </Screen>
    );
  }

  const { target } = state;
  return (
    <Screen>
      <View style={styles.head}>
        <Title>{target.title}</Title>
        {target.body !== null && <Body>{target.body}</Body>}
      </View>

      {target.reasonCopy !== null && (
        <Callout tone={target.webOnly ? "neutral" : "warn"}>
          <Body>{target.reasonCopy}</Body>
        </Callout>
      )}

      {target.actorCopy !== null && (
        <Text style={styles.actor} accessibilityRole="text">
          {target.actorCopy}
        </Text>
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
