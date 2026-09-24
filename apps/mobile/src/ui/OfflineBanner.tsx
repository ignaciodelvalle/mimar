// The offline banner — the network's absence, said once, at the top.
//
// QOL 2026-09-01. Every screen here already renders its own refusal AFTER a
// request fails ("No pudimos conectarnos…"), which is honest but reactive: a
// person in a dead spot taps, waits the whole timeout, and then learns what
// the phone knew all along. This banner is the PROACTIVE half — the OS said
// there is no network, so say it before anybody spends a tap on it.
//
// SHOWN ONLY ON A DEFINITE NO. NetInfo answers `isConnected: null` while it
// does not know (cold start, backgrounding), and a banner that cries offline
// during a half-second of "unknown" trains people to ignore it. Null and true
// render nothing.
//
// THIS IS A STATUS, NOT A GATE. Nothing is disabled and no request is
// blocked: NetInfo can be wrong (captive portals, VPNs), and a banner that
// merely informs costs nothing when it is — the per-screen refusals remain
// the authority on what actually failed. Mounted once in app/_layout.tsx,
// above the Stack, so no screen has to remember it.
//
// NATIVE DEP (@react-native-community/netinfo): real effect arrives with the
// D2 EAS build, like haptics and brightness. Until then the listener simply
// never fires and the banner never shows — the honest degradation.

import NetInfo from "@react-native-community/netinfo";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FONTS } from "./fonts";
import { COLORS, SPACE, TYPE } from "./theme";

export function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  // THE TOP INSET, BECAUSE THIS BANNER IS THE FIRST THING UNDER THE STATUS BAR
  // (A6-cuenta-resiliencia-09). It is mounted above the Stack in
  // `app/_layout.tsx`, outside every `Screen` and therefore outside the only
  // component in this app that applies safe-area padding — so on an
  // edge-to-edge Android build its text drew under the clock and the battery.
  const insets = useSafeAreaInsets();

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      // Strict false only — see the header. `null` is "unknown", not "no".
      setOffline(state.isConnected === false);
    });
    return unsubscribe;
  }, []);

  if (!offline) return null;

  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={[styles.banner, { paddingTop: insets.top + SPACE.xs }]}
    >
      <Text style={styles.text}>Sin conexión a internet</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: COLORS.warnSurface,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.warnBorder,
    paddingVertical: SPACE.xs,
    paddingHorizontal: SPACE.lg,
    alignItems: "center",
  },
  text: { fontFamily: FONTS.sansSemibold, color: COLORS.warnInk, fontSize: TYPE.sm },
});
