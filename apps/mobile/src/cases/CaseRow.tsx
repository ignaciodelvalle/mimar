// One casos row — shared by the Mis mascotas block and the casos screen, so the
// two cannot draw the same row two ways.
//
// A ROW WITH NO `route` IS DRAWN INERT, NOT OMITTED. The server sends `null`
// when the app has no screen for that cycle (a pending approval, a denuncia's
// own page). The row still says what is open — hiding it would make the app's
// list shorter than the web's — but it is not a control, and it says so to a
// screen reader.

import type { MyCaseRowV1 } from "@dim/contract/api";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { FONTS } from "../ui/fonts";
import { pressedOpacity } from "../ui/kit";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TYPE } from "../ui/theme";

import { caseDateLabel, caseRowAccessibilityLabel } from "./cases-view-model";

export function CaseRow({
  row,
  onOpenRoute,
}: {
  row: MyCaseRowV1;
  onOpenRoute: (route: string) => void;
}) {
  const { route } = row;
  const body = (
    <>
      <View style={styles.main}>
        <Text style={styles.title}>{row.title}</Text>
        {row.subtitle === "" ? null : <Text style={styles.meta}>{row.subtitle}</Text>}
      </View>
      <Text style={styles.date}>{caseDateLabel(row.since)}</Text>
    </>
  );

  if (route === null) {
    return (
      <View accessible accessibilityLabel={caseRowAccessibilityLabel(row)} style={styles.row}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={caseRowAccessibilityLabel(row)}
      onPress={() => onOpenRoute(route)}
      style={(state) => [styles.row, pressedOpacity(state)]}
    >
      {body}
    </Pressable>
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
  date: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    color: COLORS.inkMuted,
  },
});
