// The trip screens' own small shapes (viaje redesign, 2026-10-07): an option
// row, the four-segment step bar, the paper checkbox row and the trip header
// ("el pase"). LOCAL TO TRAVEL on purpose — the collapsible module is the one
// shape the design names as a kit primitive (`CollapsibleModule`); these have
// one screen each, and a primitive with one caller is a guess about the second.
//
// NO FIXED HEIGHTS. Every row has a FLOOR (`minHeight`), every text column
// shrinks and wraps, and the thing beside it (a code, a badge, a box) never
// shrinks — the shape the fixed `Row` contract settled on after the
// letter-per-line defect (QA 2026-10-07, bug 2). At font scale 1.3 rows grow
// taller instead of clipping or splitting a word letter by letter.

import { Pressable, StyleSheet, Text, View } from "react-native";

import type { PetTravelSemaforoV1 } from "@dim/contract/api";

import { Icon } from "../ui/Icon";
import { FONTS } from "../ui/fonts";
import { RIPPLE, pressedOpacityUnlessAndroidRipple } from "../ui/kit";
import { COLORS, LABEL_TRACKING_EM, LEADING, RADIUS, SPACE, TOUCH_TARGET, TYPE } from "../ui/theme";

/** The chevron that says "this row goes somewhere". Drawn, not a glyph. */
function Chevron() {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.chevronBox}
    >
      <View style={styles.chevron} />
    </View>
  );
}

/**
 * One answer in the wizard, or one destination shortcut. A whole-row target
 * (56dp floor), an optional two-letter code, a label and an optional caption.
 * `quiet` is the dashed "Todavía no sé" / "Otro país"; `chosen` is an answer
 * already given, folded into one row with "Cambiar".
 */
export function OptionRow({
  label,
  caption,
  code,
  variant = "default",
  selected = false,
  trailing,
  onPress,
  disabled = false,
  accessibilityHint,
}: {
  label: string;
  caption?: string | null;
  code?: string | null;
  variant?: "default" | "quiet" | "chosen";
  /** The answer given before going back a step: kept, and drawn as kept. */
  selected?: boolean;
  /** Replaces the chevron (the folded row's "Cambiar"). */
  trailing?: string;
  onPress: () => void;
  disabled?: boolean;
  accessibilityHint?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, selected }}
      android_ripple={RIPPLE}
      disabled={disabled}
      onPress={onPress}
      style={(state) => [
        styles.option,
        selected ? styles.optionSelected : null,
        variant === "quiet" ? styles.optionQuiet : null,
        variant === "chosen" ? styles.optionChosen : null,
        pressedOpacityUnlessAndroidRipple(state),
      ]}
    >
      {code ? (
        <View style={styles.code}>
          <Text style={styles.codeLabel}>{code}</Text>
        </View>
      ) : null}
      <View style={styles.optionText}>
        <Text style={variant === "quiet" ? styles.optionLabelQuiet : styles.optionLabel}>
          {label}
        </Text>
        {caption ? <Text style={styles.optionCaption}>{caption}</Text> : null}
      </View>
      {trailing ? <Text style={styles.trailing}>{trailing}</Text> : <Chevron />}
    </Pressable>
  );
}

/** The four-segment progress bar over "Paso N de M": progress seen, not read. */
export function StepBar({ index, total }: { index: number; total: number }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.steps}
      testID="wizard-step-bar"
    >
      {Array.from({ length: total }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the segments ARE positions.
        <View key={i} style={[styles.step, i <= index ? styles.stepOn : null]} />
      ))}
    </View>
  );
}

/**
 * One paper in "Para llevar": a 24px box in a 48dp row (design pin 22), the
 * paper's name and what the owner said about it. Same command as the old "Lo
 * tengo" button (`confirm_trip_document`); a checkbox to a screen reader.
 * Without `onToggle` (nothing may be recorded) it is a plain, inert row.
 */
export function PaperCheckRow({
  label,
  status,
  checked,
  busy,
  disabled,
  onToggle,
}: {
  label: string;
  status: string;
  checked: boolean;
  busy: boolean;
  disabled: boolean;
  onToggle?: () => void;
}) {
  const inert = onToggle === undefined;
  return (
    <Pressable
      accessibilityRole="checkbox"
      // The status is part of the name: "Lo tenés, según indicaste" is what the
      // OWNER said, which a bare checked state cannot say.
      accessibilityLabel={`${label}, ${busy ? "Guardando…" : status}`}
      accessibilityState={{ checked, disabled: disabled || inert, busy }}
      android_ripple={inert ? undefined : RIPPLE}
      disabled={disabled || inert}
      onPress={onToggle}
      style={(state) => [styles.check, inert ? null : pressedOpacityUnlessAndroidRipple(state)]}
    >
      <View style={[styles.box, checked ? styles.boxOn : null]}>
        {checked ? <Icon name="check" size="sm" color={COLORS.surface} /> : null}
      </View>
      <View style={styles.optionText}>
        <Text style={styles.checkLabel}>{label}</Text>
        <Text style={styles.optionCaption}>{busy ? "Guardando…" : status}</Text>
      </View>
    </Pressable>
  );
}

const SEMAFORO_TONE: Record<
  PetTravelSemaforoV1,
  { box: { backgroundColor: string; borderLeftColor: string }; label: { color: string } }
> = {
  rojo: {
    box: { backgroundColor: COLORS.dangerSurface, borderLeftColor: COLORS.danger },
    label: { color: COLORS.danger },
  },
  amarillo: {
    box: { backgroundColor: COLORS.warnSurface, borderLeftColor: COLORS.warnInk },
    label: { color: COLORS.warnInk },
  },
  verde: {
    box: { backgroundColor: COLORS.okSurface, borderLeftColor: COLORS.okInk },
    label: { color: COLORS.okInk },
  },
  sin_datos: {
    box: { backgroundColor: COLORS.canvas2, borderLeftColor: COLORS.inkMuted },
    label: { color: COLORS.ink },
  },
};

/**
 * "El pase": the credential's blue band with the destination and the
 * countdown, and the semáforo under it with its 6px edge. The LABEL is the
 * server's, verbatim; the count line under it is counting, not judging; the
 * countdown is date arithmetic. A past trip draws the band grey.
 */
export function TripPase({
  destination,
  countdown,
  meta,
  semaforo,
  semaforoLabel,
  countLine,
  past,
}: {
  destination: string;
  countdown: string | null;
  meta: string;
  semaforo: PetTravelSemaforoV1 | null;
  semaforoLabel: string | null;
  countLine: string | null;
  past: boolean;
}) {
  const tone = semaforo === null ? null : SEMAFORO_TONE[semaforo];
  return (
    <View style={styles.pase}>
      <View style={[styles.band, past ? styles.bandPast : null]}>
        <View style={styles.bandRow}>
          <Text style={styles.destination}>{destination}</Text>
          {countdown ? (
            <View style={styles.count}>
              <Text style={styles.countLabel}>{countdown}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.meta}>{meta}</Text>
      </View>
      {tone !== null && semaforoLabel !== null ? (
        <View style={[styles.sema, tone.box]}>
          <Text style={[styles.semaLabel, tone.label]}>{semaforoLabel}</Text>
          {countLine ? <Text style={styles.semaCount}>{countLine}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

/** A small print line — the disclaimer under the pase, said once. */
export function FinePrint({ children }: { children: string }) {
  return <Text style={styles.fine}>{children}</Text>;
}

/** The mono uppercase label over a group of options ("O empezá por el destino"). */
export function GroupLabel({ children }: { children: string }) {
  return <Text style={styles.groupLabel}>{children}</Text>;
}

/**
 * One of the three quick actions under the pase: equal thirds, a 76dp floor,
 * the label wrapping onto two lines rather than clipping.
 */
export function QuickAction({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      android_ripple={RIPPLE}
      disabled={disabled}
      onPress={onPress}
      style={(state) => [
        styles.quick,
        disabled ? styles.quickDisabled : pressedOpacityUnlessAndroidRipple(state),
      ]}
    >
      <Text style={disabled ? styles.quickLabelMuted : styles.quickLabel}>{label}</Text>
    </Pressable>
  );
}

/** "Cancelar este viaje" — the seal-red link at the end, not a wide button. */
export function SealLink({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={(state) => [styles.sealLink, pressedOpacityUnlessAndroidRipple(state)]}
    >
      <Text style={disabled ? styles.sealLinkMuted : styles.sealLinkLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chevronBox: { width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  chevron: {
    width: 8,
    height: 8,
    borderRightWidth: 2,
    borderTopWidth: 2,
    borderColor: COLORS.inkMuted,
    transform: [{ rotate: "45deg" }],
  },

  option: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    paddingHorizontal: SPACE.md + 2,
    paddingVertical: SPACE.sm + 2,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.control,
  },
  optionQuiet: {
    backgroundColor: "transparent",
    borderStyle: "dashed",
    borderColor: COLORS.borderStrong,
  },
  optionChosen: { backgroundColor: COLORS.stripe },
  optionSelected: { borderColor: COLORS.accent, backgroundColor: COLORS.focusRing },
  code: {
    flexShrink: 0,
    minWidth: 34,
    minHeight: 26,
    paddingHorizontal: 6,
    borderRadius: RADIUS.chip,
    backgroundColor: COLORS.stripe,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: "center",
    justifyContent: "center",
  },
  codeLabel: { fontFamily: FONTS.mono, fontSize: TYPE.xs, color: COLORS.inkSoft },
  optionText: { flex: 1, flexShrink: 1, gap: 2 },
  optionLabel: {
    fontFamily: FONTS.sansMedium,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.ink,
  },
  optionLabelQuiet: {
    fontFamily: FONTS.sansMedium,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.inkSoft,
  },
  optionCaption: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.sm,
    color: COLORS.inkMuted,
  },
  trailing: {
    flexShrink: 0,
    fontFamily: FONTS.sansMedium,
    fontSize: TYPE.sm,
    color: COLORS.accent,
    textDecorationLine: "underline",
  },

  steps: { flexDirection: "row", gap: SPACE.xs },
  step: { flex: 1, height: 4, borderRadius: 2, backgroundColor: COLORS.border },
  stepOn: { backgroundColor: COLORS.accent },

  check: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: SPACE.md,
    paddingHorizontal: SPACE.md + 2,
    paddingVertical: SPACE.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.borderSoft,
  },
  box: {
    flexShrink: 0,
    width: 24,
    height: 24,
    marginTop: 1,
    borderRadius: RADIUS.control,
    borderWidth: 2,
    borderColor: COLORS.borderStrong,
    backgroundColor: COLORS.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  boxOn: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  checkLabel: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.ink,
  },

  pase: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.control * 2,
    backgroundColor: COLORS.surface,
    overflow: "hidden",
  },
  band: {
    backgroundColor: COLORS.bandDeep,
    paddingHorizontal: SPACE.lg,
    paddingTop: SPACE.md + 2,
    paddingBottom: SPACE.lg,
    gap: SPACE.xs,
  },
  bandPast: { backgroundColor: COLORS.inkMuted },
  bandRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: SPACE.sm,
  },
  destination: {
    flexShrink: 1,
    fontFamily: FONTS.serif,
    fontSize: TYPE.xl2,
    lineHeight: TYPE.xl2 * LEADING.xl2,
    color: COLORS.onDark,
  },
  count: {
    flexShrink: 0,
    borderWidth: 1,
    borderColor: COLORS.celeste,
    borderRadius: RADIUS.chip,
    paddingHorizontal: 6,
    paddingVertical: SPACE.xs,
  },
  countLabel: { fontFamily: FONTS.mono, fontSize: TYPE.sm, color: COLORS.onDark },
  meta: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.sm,
    color: COLORS.celeste100,
  },
  sema: {
    borderLeftWidth: 6,
    paddingVertical: SPACE.md,
    paddingLeft: SPACE.md + 2,
    paddingRight: SPACE.lg,
    gap: 2,
  },
  semaLabel: {
    fontFamily: FONTS.sansSemibold,
    fontSize: TYPE.base,
    lineHeight: TYPE.base * LEADING.base,
  },
  semaCount: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.sm,
    color: COLORS.inkSoft,
  },

  fine: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.xs,
    lineHeight: TYPE.xs * LEADING.xs,
    color: COLORS.inkMuted,
  },
  groupLabel: {
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * LABEL_TRACKING_EM,
    textTransform: "uppercase",
    color: COLORS.inkSoft,
  },

  quick: {
    flex: 1,
    minHeight: 76,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: SPACE.xs,
    paddingVertical: SPACE.sm + 2,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.control + 2,
  },
  quickDisabled: { backgroundColor: COLORS.canvas2 },
  quickLabel: {
    textAlign: "center",
    fontFamily: FONTS.sansMedium,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.sm,
    color: COLORS.accent,
  },
  quickLabelMuted: {
    textAlign: "center",
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.sm,
    color: COLORS.inkMuted,
  },

  sealLink: {
    minHeight: TOUCH_TARGET,
    alignSelf: "center",
    justifyContent: "center",
    paddingHorizontal: SPACE.md,
  },
  sealLinkLabel: {
    fontFamily: FONTS.sansMedium,
    fontSize: TYPE.md,
    color: COLORS.seal,
    textDecorationLine: "underline",
  },
  sealLinkMuted: { fontFamily: FONTS.sans, fontSize: TYPE.md, color: COLORS.inkMuted },
});
