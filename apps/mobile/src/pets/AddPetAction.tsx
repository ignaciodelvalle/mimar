// "+ Agregar" on the "Tus mascotas · N" row, and the small bottom sheet it opens
// (PO 2026-10-07). Two ways to add an animal, in this order: register a new one
// (the primary, filled row) and claim one a vet or a shelter already registered.
// This is the ONE door to both on the home of a person who has pets; the empty
// state keeps its own big CTA and its Reclamar link, and "Reclamar" is no longer
// a row of the ☰ menu.
//
// The sheet follows `TopLevelNavMenu`'s Modal anatomy: the backdrop is a SIBLING
// of the sheet (not its wrapper) and a ref guards a double tap during the fade.

import { ChevronRight, Plus, ScanLine } from "lucide-react-native";
import { useCallback, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { FONTS } from "../ui/fonts";
import {
  RIPPLE_BORDERLESS,
  RIPPLE_ON_FILL,
  pressedOpacity,
  pressedOpacityUnlessAndroidRipple,
} from "../ui/kit";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TYPE } from "../ui/theme";

export const ADD_PET_ACTION_LABEL = "Agregar una mascota";

export function AddPetAction({
  onRegister,
  onClaim,
}: {
  onRegister: () => void;
  onClaim: () => void;
}) {
  const [open, setOpen] = useState(false);
  const chosenRef = useRef(false);

  const openSheet = useCallback(() => {
    chosenRef.current = false;
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const choose = useCallback((go: () => void) => {
    if (chosenRef.current) return;
    chosenRef.current = true;
    setOpen(false);
    go();
  }, []);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={ADD_PET_ACTION_LABEL}
        android_ripple={RIPPLE_BORDERLESS}
        onPress={openSheet}
        style={(state) => [styles.action, pressedOpacityUnlessAndroidRipple(state)]}
      >
        <Text style={styles.actionText}>+ Agregar</Text>
      </Pressable>

      <Modal animationType="fade" onRequestClose={close} transparent visible={open}>
        <View accessibilityViewIsModal style={styles.overlay}>
          <Pressable
            accessibilityLabel="Cerrar"
            accessibilityRole="button"
            onPress={close}
            style={StyleSheet.absoluteFill}
          />
          <View accessible={false} style={styles.sheet}>
            <Text accessibilityRole="header" style={styles.sheetTitle}>
              {ADD_PET_ACTION_LABEL}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Registrar una mascota nueva"
              accessibilityHint="Cargala desde cero y obtené su credencial"
              android_ripple={RIPPLE_ON_FILL}
              onPress={() => choose(onRegister)}
              style={(state) => [
                styles.row,
                styles.rowPrimary,
                pressedOpacityUnlessAndroidRipple(state),
              ]}
            >
              <View importantForAccessibility="no-hide-descendants" style={styles.rowIcon}>
                <Plus size={20} color={COLORS.onDark} strokeWidth={2} />
              </View>
              <View style={styles.rowText}>
                <Text style={[styles.rowLabel, styles.rowLabelPrimary]}>
                  Registrar una mascota nueva
                </Text>
                <Text style={[styles.rowCaption, styles.rowCaptionPrimary]}>
                  Cargala desde cero y obtené su credencial
                </Text>
              </View>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Reclamar una ya registrada"
              accessibilityHint="Si un veterinario o refugio ya la cargó: con su chip o tatuaje"
              onPress={() => choose(onClaim)}
              style={(state) => [styles.row, styles.rowSecondary, pressedOpacity(state)]}
            >
              <View importantForAccessibility="no-hide-descendants" style={styles.rowIcon}>
                <ScanLine size={20} color={COLORS.inkSoft} strokeWidth={1.75} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowLabel}>Reclamar una ya registrada</Text>
                <Text style={styles.rowCaption}>
                  Si un veterinario o refugio ya la cargó: con su chip o tatuaje
                </Text>
              </View>
              <View importantForAccessibility="no-hide-descendants">
                <ChevronRight size={16} color={COLORS.inkMuted} strokeWidth={2} />
              </View>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  // Same flex contract as `LABEL_VALUE_FLEX`: the action never shrinks, the
  // title beside it does.
  action: {
    flexShrink: 0,
    minHeight: TOUCH_TARGET,
    minWidth: TOUCH_TARGET,
    justifyContent: "center",
    alignItems: "flex-end",
    paddingLeft: SPACE.md,
  },
  actionText: {
    fontFamily: FONTS.sansMedium,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.accent,
  },
  overlay: {
    flex: 1,
    // 40% of COLORS.ink — the same derived literal `TopLevelNavMenu` uses.
    backgroundColor: "rgba(27, 42, 51, 0.4)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: RADIUS.card,
    borderTopRightRadius: RADIUS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: SPACE.lg,
    gap: SPACE.md,
  },
  sheetTitle: {
    fontFamily: FONTS.sansMedium,
    fontSize: TYPE.lg,
    lineHeight: TYPE.lg * LEADING.sm,
    color: COLORS.ink,
  },
  row: {
    minHeight: TOUCH_TARGET,
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    padding: SPACE.md,
    borderRadius: RADIUS.card,
  },
  rowPrimary: { backgroundColor: COLORS.accent },
  rowSecondary: { borderWidth: 1, borderColor: COLORS.borderStrong },
  rowIcon: { width: 22, alignItems: "center" },
  rowText: { flex: 1, flexShrink: 1, gap: 1 },
  rowLabel: {
    fontFamily: FONTS.sansMedium,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.sm,
    color: COLORS.ink,
  },
  rowLabelPrimary: { color: COLORS.onDark },
  rowCaption: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.sm,
    color: COLORS.inkMuted,
  },
  rowCaptionPrimary: { color: COLORS.onDark },
});
