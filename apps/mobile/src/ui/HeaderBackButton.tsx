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
// button's ACCESSIBLE NAME and nothing else — same destination
// (`navigation.goBack()`), same visibility rule the automatic button already
// followed (`canGoBack`).
//
// GATED SCREENS KEEP THEIR OWN `headerLeft: () => null`. `identidad-pendiente`
// and `mascotas/index` hide the back control on purpose (see `app/_layout.tsx`'s
// `headerBackVisible: false` on both) — a LOCK on the first, a stack-root
// convention on the second — and neither is this component's decision to
// override: `canGoBack` alone cannot tell "no previous screen" apart from
// "there is one, and this screen refuses the gesture anyway".
//
// THE ANDROID REFLOW, READ RATHER THAN GUESSED AT (fresh-review follow-up).
// `useHeaderConfigProps.js` (this same fork) renders the title INSIDE
// `ScreenStackHeaderCenterView`'s native slot only when Android has no custom
// `headerLeft`; the moment one is supplied, the title moves into a plain `View`
// laid out in JS beside it (`isCenterViewRenderedAndroid` flips false), which
// is the ~16dp shift and the dropped native toolbar icon the review measured.
// There is no exposed "native start inset" to match it against — the constant
// lives in the native toolbar's own padding, not in a prop this fork forwards
// — so a custom `headerLeft` on Android costs this reflow categorically, for
// any icon or glyph. What THIS component controls is everything else: a real
// icon (not a text glyph), a ripple, and a touch target that is actually
// 48×48 rather than one padded out with `hitSlop`. THE VISUAL CHECK ON THE
// SAMSUNG J7 HAPPENS AT N4 (per the overnight run's own numbering) — this
// comment is the flag for whoever runs that pass.
//
// PROPS OVER `useNavigation()` WHERE THE FORK ALREADY HANDS THEM OVER.
// `headerLeft`'s own signature (`NativeStackHeaderBackProps`) carries
// `canGoBack` and `tintColor` — computed once by `useHeaderConfigProps` from
// the same state `navigation.canGoBack()` would re-derive — so reading them
// keeps this component agreeing with the header that renders it instead of
// asking the same question twice. Nothing in that signature hands over an
// `onPress`, so `goBack` still needs `useNavigation()` — there is no shortcut
// for the one thing this component actually DOES.

import { useNavigation } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import { type ColorValue, Pressable, StyleSheet } from "react-native";

import { COLORS } from "./theme";

const TOUCH_TARGET = 48;

export function HeaderBackButton({
  canGoBack,
  tintColor,
}: {
  canGoBack?: boolean;
  // `ColorValue`, matching the header's own `NativeStackHeaderBackProps` —
  // not `string`, which `OpaqueColorValue` (a platform color / `PlatformColor()`
  // result) is not assignable to.
  tintColor?: ColorValue;
}) {
  const navigation = useNavigation();
  if (!canGoBack) return null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Volver"
      onPress={() => navigation.goBack()}
      style={styles.button}
      // `borderless` matches the native back button's own ripple shape — a
      // BOUNDED ripple would draw a visible square edge past the icon, inside
      // a control this small. `radius: 24` is half `TOUCH_TARGET`, so the
      // ripple fills the tap target exactly and no further.
      android_ripple={{ borderless: true, radius: TOUCH_TARGET / 2 }}
    >
      <ChevronLeft size={28} color={tintColor ?? COLORS.ink} strokeWidth={2} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    // MINWIDTH/MINHEIGHT, NOT `hitSlop` (fresh-review follow-up). `hitSlop`
    // grows the PRESS area without growing the node TalkBack draws a focus
    // rectangle around, so the accessible target stayed 26×26-ish (the
    // glyph's own box) no matter how generous the slop was.
    minWidth: TOUCH_TARGET,
    minHeight: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
});
