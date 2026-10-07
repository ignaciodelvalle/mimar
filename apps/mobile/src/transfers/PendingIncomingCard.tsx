// "Esperan tu respuesta" on Mis mascotas — presentational only.
// `use-pending-incoming.ts` decides WHAT is pending; this file decides HOW it is
// drawn. Words live in `pending-incoming-view-model.ts`.
//
// DRAWN ONLY WHEN THERE IS SOMETHING TO ANSWER, for `OpenCasesBlock`'s reason:
// an empty box above the animals is furniture on the screen people open most.
//
// Each row opens the existing screen where the answer is given — the
// invitation (`/cuidado/{grantToken}`) or the proposal
// (`/transferencias/{transferToken}`). Nothing here accepts or refuses.

import { Pressable, StyleSheet, Text, View } from "react-native";

import { FONTS } from "../ui/fonts";
import { Callout, LinkText, pressedOpacity } from "../ui/kit";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TRACKING, TYPE } from "../ui/theme";

import {
  PENDING_INCOMING_MAX_ROWS,
  type PendingIncomingRow,
  pendingIncomingHeading,
  pendingIncomingMoreLabel,
} from "./pending-incoming-view-model";

export function PendingIncomingCard({
  rows,
  onOpenRoute,
  onOpenAll,
}: {
  rows: PendingIncomingRow[];
  onOpenRoute: (route: PendingIncomingRow["route"]) => void;
  onOpenAll: () => void;
}) {
  if (rows.length === 0) return null;
  const shown = rows.slice(0, PENDING_INCOMING_MAX_ROWS);
  const more = pendingIncomingMoreLabel(rows.length - shown.length);

  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="polite">
      <Callout tone="warn" title={pendingIncomingHeading(rows.length)}>
        <View style={styles.rows}>
          {shown.map((row) => (
            <View key={row.key} style={styles.row}>
              <Text style={styles.eyebrow}>{row.eyebrow}</Text>
              <Text style={styles.sentence}>{row.sentence}</Text>
              <Pressable
                accessibilityRole="button"
                // Label-in-name (WCAG 2.5.3): the accessible name STARTS with the
                // visible text; the context goes in the hint, spoken after it.
                accessibilityHint={row.sentence}
                onPress={() => onOpenRoute(row.route)}
                style={(state) => [styles.cta, pressedOpacity(state)]}
              >
                <Text style={styles.ctaLabel}>{row.cta}</Text>
              </Pressable>
            </View>
          ))}
        </View>
        {more === null ? null : <LinkText onPress={onOpenAll}>{more}</LinkText>}
      </Callout>
    </View>
  );
}

const styles = StyleSheet.create({
  rows: { gap: SPACE.md, marginBottom: SPACE.xs },
  row: { gap: SPACE.xs },
  eyebrow: {
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * TRACKING.wider,
    textTransform: "uppercase",
    color: COLORS.inkMuted,
  },
  sentence: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.md,
    color: COLORS.inkSoft,
  },
  cta: {
    minHeight: TOUCH_TARGET,
    alignSelf: "flex-start",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: RADIUS.button,
    backgroundColor: COLORS.accent,
    paddingHorizontal: SPACE.lg,
  },
  ctaLabel: { fontFamily: FONTS.sansSemibold, fontSize: TYPE.md, color: COLORS.surface },
});
