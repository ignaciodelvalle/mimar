// The pet document's two loading states, drawn in the SHAPE of what arrives.
//
// `ui/skeleton.tsx` explains why detail screens kept the spinner: a generic
// card skeleton over the credential would promise a layout that is not the one
// coming. These are not generic. Each face gets a placeholder laid out like
// itself — the credential's centered photo mount, name and Cumplimiento rows;
// the libreta's name, its four-cell vaccine grid and a few asiento lines — so
// the face fills in where the bones were instead of jumping from a spinner.
//
// Built from the kit's `Skeleton` atom (motion follows the system, decoration
// hidden from assistive tech) and announced ONCE, with the sentence the
// spinner carried, the way `ListSkeleton` does.

import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { Skeleton } from "../ui/skeleton";
import { COLORS, RADIUS, SPACE } from "../ui/theme";
import { PHOTO_MOUNT } from "./chrome-visual";

/** What a screen reader hears while each face loads. */
export const CREDENTIAL_FACE_LOADING_LABEL = "Leyendo la ficha…";
export const LIBRETA_FACE_LOADING_LABEL = "Leyendo la libreta…";

function Announced({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={label}>
      <View importantForAccessibility="no-hide-descendants" style={styles.stack}>
        {children}
      </View>
    </View>
  );
}

/** Front face: photo mount, name and breed lines, then the Cumplimiento rows. */
export function CredentialFaceSkeleton() {
  return (
    <Announced label={CREDENTIAL_FACE_LOADING_LABEL}>
      <View testID="credential-face-skeleton" style={styles.identity}>
        <Skeleton w={PHOTO_MOUNT.size} h={PHOTO_MOUNT.size} radius={PHOTO_MOUNT.radius} />
        <Skeleton w="50%" h={26} />
        <Skeleton w="35%" h={13} />
        <Skeleton w={96} h={22} radius={RADIUS.chip} />
      </View>
      <View style={styles.divider} />
      <View style={styles.rows}>
        <Skeleton w="40%" h={16} />
        <Skeleton w="85%" h={13} />
        {[0, 1, 2].map((i) => (
          <View key={i} style={styles.row}>
            <Skeleton w="45%" h={13} />
            <Skeleton w="25%" h={13} />
          </View>
        ))}
      </View>
    </Announced>
  );
}

/** Back face: the name, the vaccine grid, and a few asientos. */
export function LibretaFaceSkeleton() {
  return (
    <Announced label={LIBRETA_FACE_LOADING_LABEL}>
      <View testID="libreta-face-skeleton" style={styles.stack}>
        <Skeleton w="45%" h={28} />
        <View style={styles.card}>
          <Skeleton w="50%" h={14} />
          <View style={styles.grid}>
            {[0, 1, 2, 3].map((i) => (
              <View key={i} style={styles.gridCell}>
                <Skeleton w={24} h={20} />
                <Skeleton w="60%" h={10} />
              </View>
            ))}
          </View>
        </View>
        <View style={styles.card}>
          <Skeleton w="30%" h={14} />
          <Skeleton w="25%" h={11} />
          {[0, 1, 2].map((i) => (
            <View key={i} style={styles.entry}>
              <View style={styles.entryHead}>
                <View style={styles.entryTitles}>
                  <Skeleton w="35%" h={10} />
                  <Skeleton w="65%" h={15} />
                </View>
                <Skeleton w={64} h={12} />
              </View>
              <Skeleton w="50%" h={12} />
            </View>
          ))}
        </View>
      </View>
    </Announced>
  );
}

const styles = StyleSheet.create({
  stack: { gap: SPACE.lg },
  identity: { alignItems: "center", gap: SPACE.sm },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: COLORS.border },
  rows: { gap: SPACE.sm },
  row: { flexDirection: "row", justifyContent: "space-between" },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.control,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACE.lg,
    gap: SPACE.sm,
  },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  gridCell: {
    flexBasis: "47%",
    flexGrow: 1,
    alignItems: "center",
    gap: SPACE.xs,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.control,
  },
  entry: {
    gap: SPACE.xs,
    paddingVertical: SPACE.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  entryHead: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  entryTitles: { flex: 1, gap: 4 },
});
