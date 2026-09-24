// The "Tenés una mordedura sin enviar" banner on "Mis mascotas" (M5 / Re-1,
// PO decision 3). Presentational only — `use-bite-draft-banner.ts` decides
// WHETHER to render this; this file only decides HOW.

import { Pressable, StyleSheet, Text, View } from "react-native";

import { FONTS } from "../ui/fonts";
import { Callout, pressedOpacity } from "../ui/kit";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TYPE } from "../ui/theme";

/**
 * `accessibilityRole="alert"` with a POLITE live region — `StaleNotice`'s
 * choice and its reasoning applies here too: nobody just lost anything on
 * THIS screen, the draft has been sitting since before the app opened, so
 * announcing it must not interrupt whatever a screen reader is already
 * saying about the list underneath.
 */
export function BiteDraftBanner({ onPress }: { onPress: () => void }) {
  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="polite">
      <Callout tone="warn" title="Tenés una mordedura sin enviar">
        <Text style={styles.body}>
          Quedó guardada en este teléfono, pero todavía no la enviaste. Las ventanas de observación
          de rabia corren desde el hecho, no desde que la registrás.
        </Text>
        <Text style={styles.body}>Si ya no es tu mascota, abrila y descartá el borrador.</Text>
        <Pressable
          accessibilityRole="button"
          // NO `accessibilityLabel` (WCAG 2.5.3, label-in-name): the accessible
          // name has to START WITH the visible text so a voice-control user
          // saying what they read on screen gets a match. The extra context
          // ("de la mordedura") goes in `accessibilityHint`, which is spoken
          // AFTER the name and never substitutes for it.
          accessibilityHint="Abre el formulario y recupera lo que ya habías escrito sobre la mordedura."
          onPress={onPress}
          style={(state) => [styles.cta, pressedOpacity(state)]}
        >
          <Text style={styles.ctaLabel}>Terminar de enviarla</Text>
        </Pressable>
      </Callout>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.md,
    color: COLORS.inkSoft,
    marginBottom: SPACE.sm,
  },
  cta: {
    minHeight: TOUCH_TARGET,
    alignSelf: "flex-start",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: RADIUS.button,
    backgroundColor: COLORS.accent,
    paddingHorizontal: SPACE.lg,
  },
  ctaLabel: { fontFamily: FONTS.sansSemibold, fontSize: TYPE.md, color: COLORS.surface },
});
