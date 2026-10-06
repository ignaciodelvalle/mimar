// "Casos abiertos" on Mis mascotas — the web's bandeja block (M11).
//
// DRAWN ONLY WHEN THERE IS SOMETHING OPEN. The web renders the block with an
// explanatory empty line because it sits in a section of its own; here it sits
// above the pets, and an empty box above the animals would be furniture on the
// screen people open most. The full list — open and history — is one tap away
// on the casos screen, which the footer link opens.
//
// GROUPED like the web (PO 2026-10-06): "Te toca a vos", then "En curso", one
// pet's cases gathered under the pet. Rows are normalized first, so a server
// that predates the grouping still draws (every row on its own, the turn read
// from the contract's table).

import type { MyCasesV1 } from "@dim/contract/api";
import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

import { FONTS } from "../ui/fonts";
import { Eyebrow, LinkText } from "../ui/kit";
import { COLORS, SPACE, TYPE } from "../ui/theme";

import { OpenCaseGroups } from "./CaseGroups";
import { caseCountLabel, hasOpenCases, normalizeCaseRow } from "./cases-view-model";

export function OpenCasesBlock({
  cases,
  onOpenRoute,
  onOpenAll,
}: {
  cases: MyCasesV1 | null;
  onOpenRoute: (route: string) => void;
  onOpenAll: () => void;
}) {
  const open = useMemo(() => (cases === null ? [] : cases.open.map(normalizeCaseRow)), [cases]);
  if (!hasOpenCases(cases)) return null;
  return (
    <View style={styles.block}>
      <View style={styles.head}>
        <Eyebrow>Casos abiertos</Eyebrow>
        <Text style={styles.count}>{caseCountLabel(open.length)}</Text>
      </View>
      <OpenCaseGroups rows={open} onOpenRoute={onOpenRoute} />
      <LinkText onPress={onOpenAll}>Ver todos mis casos</LinkText>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: SPACE.sm },
  head: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  count: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.inkMuted },
});
