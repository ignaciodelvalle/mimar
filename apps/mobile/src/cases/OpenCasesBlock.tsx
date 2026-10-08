// The open casos on Mis mascotas (M11; reshaped by inicio-app-rediseno,
// PO 2026-10-07).
//
// ABOVE THE PETS GOES ONLY WHAT ASKS FOR AN ANSWER. Before the redesign the
// block drew "Te toca a vos" and "En curso" at the same weight, and with two
// open casos the first pet barely showed at the foot of the first screen. Now:
//
//   · "Te toca a vos" — the casos waiting on THIS person — stays open, with its
//     eyebrow and count, because it is the one group that asks for something.
//   · "En curso" — procedures that just run their course — folds into ONE
//     `CollapsibleModule` row, closed, its count as the badge. Opening it shows
//     its rows and "Ver todos mis casos", the link that adds context there.
//   · With nothing waiting on the person, only the folded row is drawn; with
//     nothing in course, "Ver todos mis casos" sits under the waiting rows.
//
// DRAWN ONLY WHEN THERE IS SOMETHING OPEN. An empty box above the animals would
// be furniture on the screen people open most; the full list — open and history
// — has its own door now, "Mis casos" in the header menu.
//
// GROUPED like the web (PO 2026-10-06): the split and the clustering are the
// contract's (`splitOpenCaseRows`, `clusterCaseRowsByPet`), the same two calls
// the web makes, so the two surfaces cannot group the same rows two ways. Rows
// are normalized first, so a server that predates the grouping still draws.

import { type MyCasesV1, splitOpenCaseRows } from "@dim/contract/api";
import { useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { FONTS } from "../ui/fonts";
import { CollapsibleModule, Eyebrow, LinkText } from "../ui/kit";
import { COLORS, LEADING, SPACE, TYPE } from "../ui/theme";

import { CaseClusterList } from "./CaseGroups";
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
  const { yourTurn, inProgress } = useMemo(
    () => splitOpenCaseRows(cases === null ? [] : cases.open.map(normalizeCaseRow)),
    [cases],
  );
  // CLOSED ON EVERY MOUNT: nothing in "En curso" asks for an answer.
  const [inProgressOpen, setInProgressOpen] = useState(false);

  if (!hasOpenCases(cases)) return null;

  const allCasesLink = <LinkText onPress={onOpenAll}>Ver todos mis casos</LinkText>;

  return (
    <View style={styles.block}>
      {yourTurn.length === 0 ? null : (
        <View style={styles.group}>
          <View style={styles.head} accessibilityRole="header">
            <Eyebrow>Te toca a vos</Eyebrow>
            <Text style={styles.count}>{caseCountLabel(yourTurn.length)}</Text>
          </View>
          <CaseClusterList rows={yourTurn} onOpenRoute={onOpenRoute} />
          {inProgress.length === 0 ? allCasesLink : null}
        </View>
      )}
      {inProgress.length === 0 ? null : (
        <CollapsibleModule
          title="En curso"
          summary="Te avisamos si hace falta algo tuyo"
          badge={String(inProgress.length)}
          open={inProgressOpen}
          onToggle={() => setInProgressOpen((open) => !open)}
        >
          <View style={styles.moduleBody}>
            {/* Neutral on purpose — the web's words: this group also holds
                procedures that just run their course (a bite observation). */}
            <Text style={styles.hint}>Siguen su curso; te avisamos si hace falta algo tuyo.</Text>
            <CaseClusterList rows={inProgress} onOpenRoute={onOpenRoute} />
            {allCasesLink}
          </View>
        </CollapsibleModule>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: SPACE.md },
  group: { gap: SPACE.sm },
  head: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  count: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.inkMuted },
  moduleBody: { padding: SPACE.md, gap: SPACE.sm },
  hint: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.md,
    color: COLORS.inkMuted,
  },
});
