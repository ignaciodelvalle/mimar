// The launch mark: the native splash's logo, handed over to JavaScript so it can
// shrink and stay on screen as the loading mark until the app is ready.
//
// THE HAND-OFF, IN ORDER
// ---------------------------------------------------------------------------
//   1. `holdNativeSplash()` runs at module scope in the root layout: the native
//      splash stays up instead of auto-hiding on the first React frame.
//   2. `LaunchMark` mounts as an absolute overlay over the whole app, painting
//      the SAME file (`assets/splash-icon.png`) at the SAME size (the splash
//      plugin's `imageWidth`, read from app.json below) on the SAME ground,
//      centred in the same full-screen window. Underneath the native splash it
//      is pixel-for-pixel what the native splash already shows.
//   3. On its first layout it releases the native splash — exactly once. On
//      Android the native side fades out over `NATIVE_SPLASH_FADE_MS` on top of
//      an identical picture, so the fade is invisible.
//   4. After that fade, and only if the system allows motion, the logo shrinks
//      to `LAUNCH_MARK_REST_SCALE` and stays there.
//   5. When the app is ready (and the shrink has landed) the overlay fades out
//      and unmounts.
//
// IT CAN NEVER TRAP ANYBODY. `LAUNCH_MARK_TIMEOUT_MS` after mounting, the overlay
// unmounts whatever `ready` says, and `holdNativeSplash` arms the same deadline
// for the native splash in case the overlay never mounts at all (a render that
// throws above it). expo-router's own global error handler hides the native
// splash on a fatal error as well.
//
// WHY THE SIZE IS READ FROM app.json AND NOT WRITTEN HERE — THE OTA QUESTION
// ---------------------------------------------------------------------------
// This file is JavaScript and ships over the air; the native splash is a
// resource baked into the binary. If the two disagree about the logo's size,
// the hand-off is a visible jump. Two things keep them together:
//
//   · ONE NUMBER. The overlay's size IS the splash plugin's `imageWidth`, the
//     value the native build rasterised its drawable from. There is no second
//     copy to drift, and `scripts/build-mobile-app-icons.ts` reads the same key
//     to size the PNG.
//   · THE FINGERPRINT. `runtimeVersion` is `fingerprint`, and the fingerprint
//     hashes the app config, this `imageWidth` included (measured 2026-10-06:
//     moving it from 176 to 144, with the PNG regenerated to match, moved the
//     production fingerprint from a70c1c3a to f2c80c7f). An update published from a tree whose splash size differs
//     from an installed build's carries a different runtime version, and
//     expo-updates will not serve it to that build. So this overlay cannot
//     reach a binary whose native splash it does not match — the size it reads
//     is, by construction, the size that binary draws.
//
// KEPT SHALLOW ON PURPOSE: one Animated.View, one Animated.Image, no shadows.
// It is the first thing a 2 GB Android 8 phone draws.

import * as SplashScreen from "expo-splash-screen";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet } from "react-native";

import appJson from "../../app.json";
import { COLORS } from "./theme";

type SplashPluginOptions = { imageWidth?: unknown; backgroundColor?: unknown };

function splashPluginOptions(): SplashPluginOptions {
  const plugins: readonly unknown[] = appJson.expo.plugins;
  for (const entry of plugins) {
    if (Array.isArray(entry) && entry[0] === "expo-splash-screen") {
      return (entry[1] ?? {}) as SplashPluginOptions;
    }
  }
  return {};
}

const SPLASH_OPTIONS = splashPluginOptions();

/**
 * The logo's on-screen side, in dp — the splash plugin's `imageWidth`.
 *
 * `null` when app.json declares none, and then the overlay does not render at
 * all: a hand-off sized by a guess is the jump this module exists to remove.
 */
export const LAUNCH_MARK_SIZE_DP: number | null =
  typeof SPLASH_OPTIONS.imageWidth === "number" ? SPLASH_OPTIONS.imageWidth : null;

/** The splash plugin's `backgroundColor`, for the parity test. */
export const NATIVE_SPLASH_BACKGROUND: unknown = SPLASH_OPTIONS.backgroundColor;

/** Where the logo rests while the app loads, as a fraction of its splash size. */
export const LAUNCH_MARK_REST_SCALE = 0.5;
export const LAUNCH_MARK_SHRINK_MS = 450;
export const LAUNCH_MARK_FADE_MS = 200;
/**
 * The native splash's own exit fade, set explicitly rather than inherited
 * (expo-splash-screen's Android default is 400 ms). The shrink waits this long
 * so the big native logo is gone before the overlay's starts to move — two
 * logos of different sizes cross-fading reads as a double image.
 */
export const NATIVE_SPLASH_FADE_MS = 200;
/** The hard ceiling: past this, the overlay goes whatever `ready` says. */
export const LAUNCH_MARK_TIMEOUT_MS = 8000;

let nativeSplashDeadline: ReturnType<typeof setTimeout> | null = null;

/**
 * Module-scope, root layout only: keep the native splash up until the overlay
 * takes over, with a deadline in case it never does.
 */
export function holdNativeSplash(): void {
  // No size, no overlay (see LAUNCH_MARK_SIZE_DP) — so nothing to hand off to,
  // and the native splash keeps its own auto-hide.
  if (LAUNCH_MARK_SIZE_DP === null) return;
  SplashScreen.preventAutoHideAsync().catch(() => {});
  SplashScreen.setOptions({ duration: NATIVE_SPLASH_FADE_MS, fade: true });
  if (nativeSplashDeadline === null) {
    nativeSplashDeadline = setTimeout(releaseNativeSplash, LAUNCH_MARK_TIMEOUT_MS);
  }
}

function releaseNativeSplash(): void {
  if (nativeSplashDeadline !== null) {
    clearTimeout(nativeSplashDeadline);
    nativeSplashDeadline = null;
  }
  SplashScreen.hide();
}

/**
 * Whether the system asked for reduced motion. `null` while unknown; a failed
 * query answers `true` — the wrong direction to fail in is animating at
 * somebody who asked for stillness (same rule as `skeleton.tsx`).
 */
function useReduceMotion(): boolean | null {
  const [reduce, setReduce] = useState<boolean | null>(null);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted) setReduce(value);
      })
      .catch(() => {
        if (mounted) setReduce(true);
      });
    return () => {
      mounted = false;
    };
  }, []);
  return reduce;
}

const SPLASH_IMAGE = require("../../assets/splash-icon.png");

export function LaunchMark({ ready }: { ready: boolean }) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  const released = useRef(false);
  const reduceMotion = useReduceMotion();
  const [handedOff, setHandedOff] = useState(false);
  const [settled, setSettled] = useState(false);
  const [gone, setGone] = useState(false);

  // The ceiling. Releases the native splash too, in case no layout ever came.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!released.current) {
        released.current = true;
        releaseNativeSplash();
      }
      setGone(true);
    }, LAUNCH_MARK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  // The shrink — or, under reduced motion, nothing: the logo is simply settled.
  useEffect(() => {
    if (!handedOff || reduceMotion === null) return;
    if (reduceMotion) {
      setSettled(true);
      return;
    }
    const shrink = Animated.timing(scale, {
      toValue: LAUNCH_MARK_REST_SCALE,
      duration: LAUNCH_MARK_SHRINK_MS,
      delay: NATIVE_SPLASH_FADE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    shrink.start(() => setSettled(true));
    return () => shrink.stop();
  }, [handedOff, reduceMotion, scale]);

  // The exit, once the app is ready and the logo has landed.
  useEffect(() => {
    if (!ready || !settled) return;
    const fade = Animated.timing(opacity, {
      toValue: 0,
      duration: LAUNCH_MARK_FADE_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    fade.start(() => setGone(true));
    return () => fade.stop();
  }, [ready, settled, opacity]);

  if (gone || LAUNCH_MARK_SIZE_DP === null) return null;

  const onLayout = () => {
    if (released.current) return;
    released.current = true;
    releaseNativeSplash();
    setHandedOff(true);
  };

  return (
    <Animated.View
      testID="launch-mark"
      onLayout={onLayout}
      // Opaque over the app while it loads, so a stray tap cannot land on a
      // screen nobody can see yet; transparent to touch from the moment it
      // starts to leave.
      pointerEvents={ready && settled ? "none" : "auto"}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Cargando"
      style={[styles.overlay, { opacity }]}
    >
      <Animated.Image
        testID="launch-mark-logo"
        source={SPLASH_IMAGE}
        resizeMode="contain"
        style={{
          width: LAUNCH_MARK_SIZE_DP,
          height: LAUNCH_MARK_SIZE_DP,
          transform: [{ scale }],
        }}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.canvas,
  },
});
