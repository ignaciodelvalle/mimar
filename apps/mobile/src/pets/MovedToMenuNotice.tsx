// The one-time notice on Mis mascotas: "Lo que estaba abajo ahora está en el
// menú ☰" (inicio-app-rediseno, PO 2026-10-07, question 3 of the review).
//
// WHY IT EXISTS. The home used to end in nine buttons; the redesign moved all of
// them into the header's ☰ (and Notificaciones into the bell). Somebody who knew
// where "Mis turnos" was would scroll to the bottom and find nothing. This says
// where it went, ONCE: a neutral `Callout` with a close control, and once closed
// it never comes back on this install.
//
// PER INSTALL, NOT PER ACCOUNT, unlike `push-priming-preference.ts`. That one
// records a choice a PERSON made about their own notifications; this one records
// that this app's layout change has been explained on this phone, which is a
// fact about the install.
//
// NOT DRAWN UNTIL STORAGE HAS ANSWERED. Drawing it first and hiding it a frame
// later would flash a notice at exactly the people who already closed it. A
// storage read that FAILS shows it — the recoverable direction: one more tap on
// "Entendido" costs less than a layout change nobody explained. A write that
// fails is silent: the notice still closes for this session.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { FONTS } from "../ui/fonts";
import { Callout, LinkText } from "../ui/kit";
import { COLORS, LEADING, SPACE, TYPE } from "../ui/theme";

/** The one place the key is spelled. */
export const HOME_MENU_NOTICE_DISMISSED_KEY = "mimar.homeMenuNotice.dismissed";

export const HOME_MENU_NOTICE_TEXT = "Lo que estaba abajo ahora está en el menú ☰";

/** Has this install already closed the notice? A failed read answers `false`. */
export async function readHomeMenuNoticeDismissed(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(HOME_MENU_NOTICE_DISMISSED_KEY)) === "1";
  } catch {
    return false;
  }
}

/** Records the dismissal. Best-effort — see the header. */
export async function writeHomeMenuNoticeDismissed(): Promise<void> {
  try {
    await AsyncStorage.setItem(HOME_MENU_NOTICE_DISMISSED_KEY, "1");
  } catch {
    // Intentionally silent — see the header.
  }
}

type NoticeState = "unknown" | "visible" | "dismissed";

/** Whether to draw the notice, and the handler that closes it for good. */
export function useHomeMenuNotice(): { visible: boolean; dismiss: () => void } {
  const [state, setState] = useState<NoticeState>("unknown");

  useEffect(() => {
    let alive = true;
    void readHomeMenuNoticeDismissed().then((dismissed) => {
      if (!alive) return;
      // A close tapped while the read was in flight wins over the read.
      setState((current) =>
        current === "dismissed" ? current : dismissed ? "dismissed" : "visible",
      );
    });
    return () => {
      alive = false;
    };
  }, []);

  const dismiss = useCallback(() => {
    setState("dismissed");
    void writeHomeMenuNoticeDismissed();
  }, []);

  return { visible: state === "visible", dismiss };
}

export function MovedToMenuNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Callout tone="neutral">
      <View style={styles.body}>
        <Text
          // "☰" alone is read as a symbol name or not at all; say where it is.
          accessibilityLabel="Lo que estaba abajo ahora está en el menú, arriba a la derecha."
          style={styles.text}
        >
          {HOME_MENU_NOTICE_TEXT}
        </Text>
        <LinkText onPress={onDismiss} accessibilityHint="Cierra este aviso. No vuelve a aparecer.">
          Entendido
        </LinkText>
      </View>
    </Callout>
  );
}

const styles = StyleSheet.create({
  body: { gap: SPACE.sm, alignItems: "flex-start" },
  text: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.ink,
  },
});
