// The casos, grouped the way the web's Bandeja groups them (PO 2026-10-06).
//
// `OpenCaseGroups` draws "Te toca a vos" and "En curso"; `CaseClusterList`
// draws any group's rows with one pet's rows gathered under the pet once there
// are two or more. The ORDER and the CLUSTERING are the contract's
// (`splitOpenCaseRows`, `clusterCaseRowsByPet`) — the same two calls the web
// makes — so the two surfaces cannot group the same rows two ways. Every row
// handed in must already be normalized (`normalizeCaseRow`).

import {
  type CasePetCluster,
  type MyCaseRowV1,
  clusterCaseRowsByPet,
  splitOpenCaseRows,
} from "@dim/contract/api";
import { StyleSheet, Text, View } from "react-native";

import { FONTS } from "../ui/fonts";
import { COLORS, LEADING, SPACE, TYPE } from "../ui/theme";

import { CaseRow } from "./CaseRow";
import { PetThumb } from "./PetThumb";
import { caseCountLabel, petClusterAccessibilityLabel } from "./cases-view-model";

type OpenRoute = (route: string) => void;
type GroupProps = { rows: MyCaseRowV1[]; onOpenRoute: OpenRoute };

export function OpenCaseGroups({ rows, onOpenRoute }: GroupProps) {
  const { yourTurn, inProgress } = splitOpenCaseRows(rows);
  return (
    <View style={styles.groups}>
      <View style={styles.group}>
        <GroupHead title="Te toca a vos" count={yourTurn.length} />
        {yourTurn.length === 0 ? (
          <Text style={styles.hint}>Nada pendiente de tu parte por ahora.</Text>
        ) : (
          <CaseClusterList rows={yourTurn} onOpenRoute={onOpenRoute} />
        )}
      </View>
      {inProgress.length === 0 ? null : (
        <View style={styles.group}>
          <GroupHead title="En curso" count={inProgress.length} />
          {/* Neutral on purpose — the web's words: this group also holds
              procedures that just run their course (a bite observation). */}
          <Text style={styles.hint}>Siguen su curso; te avisamos si hace falta algo tuyo.</Text>
          <CaseClusterList rows={inProgress} onOpenRoute={onOpenRoute} />
        </View>
      )}
    </View>
  );
}

function GroupHead({ title, count }: { title: string; count: number }) {
  return (
    <View style={styles.groupHead} accessibilityRole="header">
      <Text style={styles.groupTitle}>{title}</Text>
      {count === 0 ? null : <Text style={styles.hint}>{`· ${count}`}</Text>}
    </View>
  );
}

export function CaseClusterList({ rows, onOpenRoute }: GroupProps) {
  const clusters = clusterCaseRowsByPet(rows);
  return (
    <View style={styles.list}>
      {clusters.map((cluster, index) => {
        const [only] = cluster.rows;
        if (cluster.rows.length === 1 && only) {
          // No id crosses the wire (see the contract); the server's order is
          // the row's identity for as long as this payload is on screen.
          // biome-ignore lint/suspicious/noArrayIndexKey: positional rows by design
          return <CaseRow key={index} row={only} onOpenRoute={onOpenRoute} />;
        }
        return (
          <PetCaseCluster
            key={`pet:${cluster.petId}`}
            cluster={cluster}
            onOpenRoute={onOpenRoute}
          />
        );
      })}
    </View>
  );
}

/** Two or more rows about one pet: the pet once, with a count, and its rows under it. */
function PetCaseCluster({
  cluster,
  onOpenRoute,
}: {
  cluster: CasePetCluster<MyCaseRowV1>;
  onOpenRoute: OpenRoute;
}) {
  return (
    <View style={styles.cluster}>
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={petClusterAccessibilityLabel(cluster.petName, cluster.rows.length)}
        style={styles.clusterHead}
      >
        <PetThumb uri={cluster.petPhotoUrl} size={28} />
        <Text style={styles.petName} numberOfLines={1}>
          {cluster.petName}
        </Text>
        <Text style={styles.hint}>{caseCountLabel(cluster.rows.length)}</Text>
      </View>
      <View style={styles.clusterRows}>
        {cluster.rows.map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional rows by design
          <CaseRow key={index} row={row} onOpenRoute={onOpenRoute} showPet={false} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  groups: { gap: SPACE.lg },
  group: { gap: SPACE.sm },
  groupHead: { flexDirection: "row", alignItems: "baseline", gap: SPACE.sm },
  groupTitle: {
    fontFamily: FONTS.sansSemibold,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.ink,
  },
  hint: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.md,
    color: COLORS.inkMuted,
  },
  list: { gap: SPACE.sm },
  cluster: { gap: SPACE.xs },
  clusterHead: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
  petName: {
    flexShrink: 1,
    fontFamily: FONTS.sansSemibold,
    fontSize: TYPE.md,
    color: COLORS.ink,
  },
  clusterRows: {
    gap: SPACE.sm,
    marginLeft: 14,
    paddingLeft: SPACE.sm,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: COLORS.border,
  },
});
