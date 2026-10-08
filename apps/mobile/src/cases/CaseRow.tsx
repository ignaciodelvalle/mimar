// One casos row — shared by the Mis mascotas block and the casos screen, so the
// two cannot draw the same row two ways.
//
// A ROW WITH NO `route` IS DRAWN INERT, NOT OMITTED. The server sends `null`
// when the app has no screen for that cycle (a pending approval, a denuncia's
// own page). The row still says what is open — hiding it would make the app's
// list shorter than the web's — but it is not a control, and it says so to a
// screen reader.
//
// SEVERITY IS DRAWN, like the web's tinted tile (PO 2026-10-06): urgent and
// warning rows wear the warning triangle in their own tone, the rest the
// informational glyph. The pet the row is about rides under the text — its
// photo and name — unless the row sits inside that pet's cluster, whose head
// already names it.
//
// THE DATE RIDES ON THAT SAME LINE, after the pet (pulido-kit-listas,
// 2026-10-07). It used to be a third column at the row's right edge, and a
// column that never shrinks takes its width from the text: at font scale 1.3
// the title and subtitle were left a sliver and the row ran to six lines. On
// the meta line it costs one word, and the line wraps instead of the body.

import type { MyCaseRowV1 } from "@dim/contract/api";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Icon } from "../ui/Icon";
import { FONTS } from "../ui/fonts";
import { pressedOpacity } from "../ui/kit";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TYPE } from "../ui/theme";

import { PetThumb } from "./PetThumb";
import { caseDateLabel, caseDueLabel, caseRowAccessibilityLabel } from "./cases-view-model";

export function CaseRow({
  row,
  onOpenRoute,
  showPet = true,
}: {
  row: MyCaseRowV1;
  onOpenRoute: (route: string) => void;
  /** `false` inside a pet's cluster, whose head already shows the pet. */
  showPet?: boolean;
}) {
  const { route } = row;
  const due = caseDueLabel(row);
  const body = (
    <>
      <SeverityTile severity={row.severity} />
      <View style={styles.main}>
        <Text style={styles.title}>{row.title}</Text>
        {row.subtitle === "" ? null : <Text style={styles.meta}>{row.subtitle}</Text>}
        {due === null ? null : <Text style={styles.due}>{due}</Text>}
        <View style={styles.metaLine}>
          {showPet && row.petName !== null ? (
            <>
              <PetThumb uri={row.petPhotoUrl} size={20} />
              <Text style={[styles.meta, styles.petName]} numberOfLines={1}>
                {row.petName}
              </Text>
              <Text accessibilityElementsHidden importantForAccessibility="no" style={styles.meta}>
                ·
              </Text>
            </>
          ) : null}
          <Text style={styles.meta}>{caseDateLabel(row.since)}</Text>
        </View>
      </View>
    </>
  );

  if (route === null) {
    return (
      <View
        accessible
        accessibilityLabel={caseRowAccessibilityLabel(row, { withPet: showPet })}
        style={styles.row}
      >
        {body}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={caseRowAccessibilityLabel(row, { withPet: showPet })}
      onPress={() => onOpenRoute(route)}
      style={(state) => [styles.row, pressedOpacity(state)]}
    >
      {body}
    </Pressable>
  );
}

/** The web's tinted severity tile, decorative: the row's label already carries the meaning. */
function SeverityTile({ severity }: { severity: MyCaseRowV1["severity"] }) {
  const tone =
    severity === "urgent"
      ? { surface: COLORS.dangerSurface, ink: COLORS.danger, icon: "alert-triangle" }
      : severity === "warning"
        ? { surface: COLORS.warnSurface, ink: COLORS.warnInk, icon: "alert-triangle" }
        : { surface: COLORS.focusRing, ink: COLORS.accent, icon: "info" };
  return (
    <View
      testID={`case-severity-${severity}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.tile, { backgroundColor: tone.surface }]}
    >
      <Icon name={tone.icon} size="sm" color={tone.ink} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACE.sm,
    minHeight: TOUCH_TARGET,
    paddingVertical: SPACE.sm,
    paddingHorizontal: SPACE.md,
    borderRadius: RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  tile: {
    width: 32,
    height: 32,
    borderRadius: RADIUS.control,
    alignItems: "center",
    justifyContent: "center",
  },
  main: { flex: 1, gap: SPACE.xs / 2 },
  title: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.ink,
  },
  meta: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.md,
    color: COLORS.inkMuted,
  },
  due: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.md,
    color: COLORS.warnInk,
  },
  metaLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACE.xs },
  // The name yields before the date does: a long name truncates, the date stays.
  petName: { flexShrink: 1 },
});
