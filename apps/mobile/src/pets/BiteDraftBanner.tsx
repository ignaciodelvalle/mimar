// The "Tenés una mordedura sin enviar" banner on "Mis mascotas" (M5 / Re-1,
// PO decision 3). Presentational only — `use-bite-draft-banner.ts` decides
// WHETHER to render this; this file only decides HOW.

import { Pressable, StyleSheet, Text, View } from "react-native";

import { FONTS } from "../ui/fonts";
import { Callout, pressedOpacity } from "../ui/kit";
import { COLORS, LEADING, RADIUS, SPACE, TYPE } from "../ui/theme";

/**
 * Android's stronger 48dp convention, the same one `TopLevelNavMenu.tsx`
 * reserves for its persistent header button (`HEADER_TOUCH_TARGET`) rather
 * than the 44dp form-control floor (`TOUCH_TARGET` in `theme.ts`). This CTA
 * gets the same headroom: it is the one control on "Mis mascotas" that
 * reopens a form about a still-open rabies observation window, not an
 * ordinary list action.
 */
const CTA_TOUCH_TARGET = 48;

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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Terminar de enviar la mordedura"
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
    minHeight: CTA_TOUCH_TARGET,
    alignSelf: "flex-start",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: RADIUS.button,
    backgroundColor: COLORS.accent,
    paddingHorizontal: SPACE.lg,
  },
  ctaLabel: { fontFamily: FONTS.sansSemibold, fontSize: TYPE.md, color: COLORS.surface },
});
