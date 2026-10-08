// The small shapes the lost screen's panes share — the disclosure row, the
// date formats, the command-builder unwrap — split out of `LostScreen.tsx`
// when the screen was broken into panes (custody polish, 2026-10-07). LOCAL TO
// LOST on purpose: they have one screen, and a kit primitive with one caller is
// a guess about the second.

import { Pressable, StyleSheet, Text, View } from "react-native";

import type { LostCommandInput } from "@dim/contract/input";

import { Body } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { RIPPLE, pressedOpacityUnlessAndroidRipple } from "../ui/kit";
import { COLORS, LABEL_TRACKING_EM, LEADING, SPACE, TOUCH_TARGET, TYPE } from "../ui/theme";

import {
  DISCLOSURE_TITULAR_ONLY_NOTE,
  type DisclosureKey,
  type buildMarkFound,
  disclosureHelp,
  disclosureLabel,
} from "./lost-view-model";

/** How every pane sends a command: the screen's `run`. */
export type RunFn = (input: LostCommandInput, idempotencyKey: string | null) => Promise<void>;

/**
 * One disclosure preference — the privacy surface of the whole feature.
 *
 * A preference this caller may not change is SHOWN and marked, not hidden and
 * never a live switch that would answer 403 (see the screen's header). The
 * editable one is a whole-row switch: the label, its value and the sentence
 * saying WHO sees it, in one 48dp-floored target.
 */
export function DisclosureRow({
  row,
  busy,
  onToggle,
}: {
  row: { key: DisclosureKey; value: boolean; editable: boolean };
  busy: boolean;
  onToggle: () => void;
}) {
  const stateLabel = row.value ? "Sí" : "No";

  if (!row.editable) {
    return (
      <View style={styles.disclosureRow}>
        <Text style={styles.disclosureLabel}>{disclosureLabel(row.key)}</Text>
        <Body>{`${stateLabel} — ${DISCLOSURE_TITULAR_ONLY_NOTE}`}</Body>
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: row.value, disabled: busy }}
      accessibilityHint={disclosureHelp(row.key)}
      android_ripple={RIPPLE}
      disabled={busy}
      onPress={onToggle}
      style={(state) => [styles.disclosureRow, pressedOpacityUnlessAndroidRipple(state)]}
    >
      <View style={styles.disclosureHead}>
        <Text style={styles.disclosureLabel}>{disclosureLabel(row.key)}</Text>
        <Text style={row.value ? styles.disclosureOn : styles.disclosureOff}>{stateLabel}</Text>
      </View>
      <Text style={styles.disclosureHelp}>{disclosureHelp(row.key)}</Text>
    </Pressable>
  );
}

/** The mono date line under a feed row or a reported message. */
export function MetaLine({ children }: { children: string }) {
  return <Text style={styles.meta}>{children}</Text>;
}

/**
 * The four commands with NO form cannot fail validation — they have no fields.
 *
 * They still go through the contract's schema, because "this build and the
 * contract agree about what a command is" is worth checking once at the boundary
 * rather than assuming. A failure here is a build out of step with its own
 * contract, which is a bug and not a user's mistake.
 */
export function unwrap(result: ReturnType<typeof buildMarkFound>): LostCommandInput {
  if (!result.ok) throw new Error(`lost command failed to build: ${result.code ?? "unknown"}`);
  return result.input;
}

/** `"2026-08-20T12:00:00Z"` → `"20/08/2026"`. */
export function formatIsoDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
}

/** `"2026-08-20T12:00:00Z"` → `"20/08/2026 09:00"`, in Argentine time. */
export function formatIsoDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const lostStyles = StyleSheet.create({
  /** A module's body: the rows inside a `CollapsibleModule`, padded off its edge. */
  moduleBody: { gap: SPACE.sm, paddingHorizontal: SPACE.md + 2, paddingVertical: SPACE.sm },
  /** The section heading inside a pane (a form's group, the case detail). */
  section: { gap: SPACE.sm },
  /** Form fields inside a module: the screen's own field rhythm. */
  fields: { gap: SPACE.lg, paddingVertical: SPACE.md },
});

const styles = StyleSheet.create({
  // NO FIXED HEIGHT: a floor, and the text column wraps — at font scale 1.3 the
  // row grows instead of clipping (the shape `CollapsibleModule` settled on).
  disclosureRow: {
    alignSelf: "stretch",
    minHeight: TOUCH_TARGET,
    justifyContent: "center",
    gap: SPACE.xs,
    paddingVertical: SPACE.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.borderSoft,
  },
  disclosureHead: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: SPACE.md,
  },
  disclosureLabel: {
    flex: 1,
    flexShrink: 1,
    fontFamily: FONTS.sansMedium,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.ink,
  },
  disclosureOn: {
    flexShrink: 0,
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.sm,
    letterSpacing: TYPE.sm * LABEL_TRACKING_EM,
    textTransform: "uppercase",
    color: COLORS.accent,
  },
  disclosureOff: {
    flexShrink: 0,
    fontFamily: FONTS.mono,
    fontSize: TYPE.sm,
    letterSpacing: TYPE.sm * LABEL_TRACKING_EM,
    textTransform: "uppercase",
    color: COLORS.inkMuted,
  },
  disclosureHelp: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.sm,
    color: COLORS.inkSoft,
  },
  meta: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * LABEL_TRACKING_EM,
    color: COLORS.inkMuted,
  },
});
