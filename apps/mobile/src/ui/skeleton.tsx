// Skeletons — loading placeholders with the SHAPE of what is coming.
//
// The mirror of the web's `Skeleton` / `LnCardSkeleton` / `LnPageSkeleton`
// (components/ui): a spinner says "something is happening"; a skeleton says
// "a list of cards is coming, and this is where they will be" — which is why
// the LIST screens use these (QOL 2026-09-01) while detail screens keep
// `Loading`: a generic card skeleton over the credential or a turno detail
// would promise a layout that is not the one arriving, and a placeholder that
// lies about shape is worse than a spinner.
//
// MOTION FOLLOWS THE SYSTEM. The web's atom goes static under
// prefers-reduced-motion; here `AccessibilityInfo.isReduceMotionEnabled`
// answers async, so the pulse starts only after the system says it may. The
// default while unknown is STATIC — the wrong direction to fail in is
// animating at somebody who asked for stillness.
//
// ACCESSIBILITY MIRRORS THE WEB'S SPLIT: the bones are pure decoration and
// hidden from assistive tech; the composite announces itself once, as the
// web's aria-busy region does — so a screen reader hears "Cargando tus
// turnos" exactly once instead of a page of unlabeled rectangles.

import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from "react-native";

import { COLORS, RADIUS, SPACE } from "./theme";

/** True once the system reported reduced motion; false while unknown. */
function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted) setReduce(value);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);
  return reduce;
}

/** The shimmer atom. Sizes are numbers (dp), mirroring the web's w/h/radius. */
export function Skeleton({
  w = "100%",
  h = 14,
  radius = 3,
}: {
  w?: number | `${number}%`;
  h?: number;
  radius?: number;
}) {
  const reduce = useReduceMotion();
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reduce) return;
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.5,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [opacity, reduce]);

  return (
    <Animated.View style={[styles.bone, { width: w, height: h, borderRadius: radius, opacity }]} />
  );
}

/** One card-shaped placeholder — the LnCardSkeleton proportions. */
export function CardSkeleton() {
  return (
    <View style={styles.card}>
      <Skeleton w="45%" h={12} />
      <View style={styles.avatarRow}>
        <Skeleton w={40} h={40} radius={20} />
        <View style={styles.avatarLines}>
          <Skeleton w="60%" h={13} />
          <Skeleton w="40%" h={11} />
        </View>
      </View>
      <Skeleton w="80%" h={13} />
      <Skeleton w="55%" h={13} />
    </View>
  );
}

/**
 * The list-screen placeholder: `rows` cards where the cards will be.
 * `label` is what a screen reader hears — the same sentence the `Loading`
 * spinner it replaces used to carry.
 */
export function ListSkeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={label} style={styles.list}>
      <View importantForAccessibility="no-hide-descendants" style={styles.list}>
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: identical stateless placeholders that never reorder — the index IS the identity.
          <CardSkeleton key={i} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bone: { backgroundColor: COLORS.border },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.control,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACE.lg,
    gap: SPACE.sm,
  },
  avatarRow: { flexDirection: "row", alignItems: "center", gap: SPACE.md },
  avatarLines: { flex: 1, gap: SPACE.xs },
  list: { gap: SPACE.lg },
});
