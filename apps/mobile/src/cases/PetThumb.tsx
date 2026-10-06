// The pet's photo at casos size — a row's chip (20) or a cluster's head (28).
//
// The same two rules `PetRow` follows, at a size where a word no longer fits:
// a STABLE `source` (memoized on the url, so a re-render does not hand <Image>
// a new object), and a photo that fails to LOAD falls back to the paw instead
// of an empty box that reads as "no photo".

import { useMemo, useState } from "react";
import { Image, StyleSheet, View } from "react-native";

import { Icon } from "../ui/Icon";
import { COLORS } from "../ui/theme";

export function PetThumb({ uri, size }: { uri: string | null; size: number }) {
  const [failed, setFailed] = useState(false);
  const source = useMemo(() => (uri === null ? null : { uri }), [uri]);
  const frame = { width: size, height: size, borderRadius: size / 2 };

  if (source === null || failed) {
    return (
      <View
        testID="pet-thumb-fallback"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.fallback, frame]}
      >
        <Icon name="paw" size={Math.round(size * 0.6)} color={COLORS.inkMuted} />
      </View>
    );
  }
  return (
    <Image
      testID="pet-thumb"
      source={source}
      style={[styles.photo, frame]}
      accessibilityIgnoresInvertColors
      accessibilityElementsHidden
      importantForAccessibility="no"
      onError={() => setFailed(true)}
    />
  );
}

const styles = StyleSheet.create({
  photo: { borderWidth: StyleSheet.hairlineWidth, borderColor: COLORS.border },
  fallback: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    backgroundColor: COLORS.stripe,
  },
});
