// "Casos abiertos" on Mis mascotas — the web's bandeja block (M11).
//
// DRAWN ONLY WHEN THERE IS SOMETHING OPEN. The web renders the block with an
// explanatory empty line because it sits in a section of its own; here it sits
// above the pets, and an empty box above the animals would be furniture on the
// screen people open most. The full list — open and history — is one tap away
// on the casos screen, which the footer link opens.

import type { MyCasesV1 } from "@dim/contract/api";
import { StyleSheet, Text, View } from "react-native";

import { FONTS } from "../ui/fonts";
import { Eyebrow, LinkText } from "../ui/kit";
import { COLORS, SPACE, TYPE } from "../ui/theme";

import { CaseRow } from "./CaseRow";
import { caseCountLabel, hasOpenCases } from "./cases-view-model";

export function OpenCasesBlock({
  cases,
  onOpenRoute,
  onOpenAll,
}: {
  cases: MyCasesV1 | null;
  onOpenRoute: (route: string) => void;
  onOpenAll: () => void;
}) {
  if (!hasOpenCases(cases)) return null;
  return (
    <View style={styles.block}>
      <View style={styles.head}>
        <Eyebrow>Casos abiertos</Eyebrow>
        <Text style={styles.count}>{caseCountLabel(cases.open.length)}</Text>
      </View>
      {cases.open.map((row, index) => (
        // No id crosses the wire (see the contract); the server's order is the
        // row's identity for as long as this payload is on screen.
        // biome-ignore lint/suspicious/noArrayIndexKey: positional rows by design
        <CaseRow key={index} row={row} onOpenRoute={onOpenRoute} />
      ))}
      <LinkText onPress={onOpenAll}>Ver todos mis casos</LinkText>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: SPACE.sm },
  head: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  count: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.inkMuted },
});
