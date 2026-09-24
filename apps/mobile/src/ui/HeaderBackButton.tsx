// The native stack's back button, replaced for its accessible NAME only.
//
// A-4 (native review): TalkBack announces "Navigate up" on this control app-
// wide. That string is AndroidX's own default for a Toolbar navigation icon
// that never got `setNavigationContentDescription()` called on it — and
// nothing in this stack calls it. The natural fix would be a declarative prop
// (`headerBackAccessibilityLabel`, which older React Navigation native-stack
// versions carry) — checked against this build's actual dependency
// (`expo-router`'s own fork under `build/react-navigation/native-stack/`,
// backed by `react-native-screens` 4.26.2) and NEITHER exposes one: the
// header-item `accessibilityLabel` in that fork's types is for a manually
// added header BUTTON, not for the automatic back control this app never
// configures as one. Upgrading either package to chase a newer prop is out of
// scope for a copy fix and outside this build's `runtimeVersion` contract
// besides.
//
// So this is the "house header" the review names as the other option: a
// screen's OWN control standing in for the automatic one, exactly the pattern
// `HeaderMenuButton` already sets for `headerRight`. It replaces the back
// button's ACCESSIBLE NAME and nothing else — same tap target, same
// destination (`navigation.goBack()`), same visibility rule the automatic
// button already followed (`canGoBack()`).
//
// GATED SCREENS KEEP THEIR OWN `headerLeft: () => null`. `identidad-pendiente`
// and `mascotas/index` hide the back control on purpose (see `app/_layout.tsx`'s
// `headerBackVisible: false` on both) — a LOCK on the first, a stack-root
// convention on the second — and neither is this component's decision to
// override: `canGoBack()` alone cannot tell "no previous screen" apart from
// "there is one, and this screen refuses the gesture anyway".

import { useNavigation } from "expo-router";
import { Pressable, StyleSheet, Text } from "react-native";

import { COLORS, SPACE } from "./theme";

/**
 * The default control's own visual, kept deliberately plain: a glyph in the
 * SAME tint color `app/_layout.tsx`'s `screenOptions.headerTintColor` already
 * gives the header (`COLORS.ink`), rather than a platform-specific icon
 * asset — the point of this component is the accessible NAME, not a redesign
 * of a control that already looks right on both platforms.
 */
export function HeaderBackButton() {
  const navigation = useNavigation();
  if (!navigation.canGoBack()) return null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Volver"
      hitSlop={SPACE.sm}
      onPress={() => navigation.goBack()}
      style={styles.button}
    >
      <Text style={styles.glyph}>‹</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -SPACE.xs,
  },
  glyph: {
    fontSize: 30,
    lineHeight: 32,
    color: COLORS.ink,
  },
});
