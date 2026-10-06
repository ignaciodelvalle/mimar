// The panel BELOW the credential — what the person responsible for the animal
// can do with it (owner-pet-actions, PO plan 2026-10-01).
//
// WHY IT LEFT THE CARD. The front face used to end in a pill row — Anotar,
// Compartir, Modo perdida, Más — and "Más" unfolded fourteen unrelated rows
// inside the credential, two of them duplicates ("Credencial pública" was the QR
// tap again; "Contactos de emergencia" opened the same screen as "Editar
// datos"). The PO's words: useful buttons mixed with "doors to folders of
// unrelated buttons". The credential is a document; this is what a person does
// with it, so it sits below the card and scrolls with the page:
//
//   [ Anotar ] [ Compartir ] [ Modo perdida ]     the primary row
//   …the sections that were already below the card (Recordatorios, Trámites)…
//   LA MASCOTA · SALUD · VIAJES · CUSTODIA        the old Más rows, grouped
//   ─────────  Reportar fallecimiento             apart, last
//
// THE SECTIONS IN THE MIDDLE ARRIVE AS `children`, so the screen mounts ONE
// panel and the order above lives in one place. They are not this component's
// business beyond where they sit.
//
// NOTHING HERE DECIDES WHO GETS WHAT, AND NO STRING HERE IS ITS OWN. Every row,
// whether it is live or grey, its label, hint, caption and group heading come
// from the contract's catalogue (`derivePetActions`) through `ownerPanelView`,
// which adds only where each row goes on a phone. A label typed into this file
// would be the fourth copy of a list that already drifted with three.
//
// A ROW THAT DOES NOT APPLY IS GREY WITH ITS REASON (PO), never missing:
// `ListRow`'s inert arm draws it muted, announces `disabled`, and shows the
// caption — "Solo el titular", "No disponible para cuidadores" — so a co-owner
// learns the transfer exists and whose it is BEFORE typing an address into a
// form whose answer would be a refusal. What is absent is absent by the
// catalogue's rule (a deceased animal, the organization path, a cat's
// assistance-dog row), not by this file's.
//
// No animation: the groups are always open, so there is nothing to expand. If
// one is ever added it is core `Animated`, never reanimated — a new native
// module moves the Expo fingerprint and costs a store build.

import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { Icon } from "../ui/Icon";
import { FONTS } from "../ui/fonts";
import { Eyebrow, ListRow, pressedOpacity } from "../ui/kit";
import { COLORS, LEADING, SPACE, TOUCH_TARGET, TYPE } from "../ui/theme";
import type {
  OwnerPanelGroup,
  OwnerPanelRow,
  OwnerPanelView,
  PanelTarget,
} from "./owner-face-view-model";

type Go = (target: PanelTarget) => void;

export function OwnerActionPanel({
  panel,
  children,
}: {
  panel: OwnerPanelView;
  /** What sits between the primary row and the groups: the existing sections. */
  children?: ReactNode;
}) {
  const router = useRouter();
  const go: Go = (target) => router.push(target);
  return (
    <>
      <View style={styles.primaryRow}>
        {panel.primary.map((row) => (
          <PrimaryAction key={row.id} row={row} onGo={go} />
        ))}
      </View>
      {children}
      {panel.groups.map((group) => (
        <ActionGroup key={group.id} group={group} onGo={go} />
      ))}
    </>
  );
}

/**
 * One act of the primary strip — web `.ln-act`: icon beside label, card fill,
 * strong warm border, 10px radius. Full-width stack under the credential so
 * "Modo perdida" never wraps into a cramped third on a 360dp phone.
 *
 * With no target the act is the honest-disabled rendering: same chrome, muted,
 * announcing `disabled`. The catalogue never makes a primary action grey today
 * (each is live or absent), and the arm stays so a future rule cannot draw a
 * live-looking control that does nothing.
 */
function PrimaryAction({ row, onGo }: { row: OwnerPanelRow; onGo: Go }) {
  const { target } = row;
  const inert = target === null;
  const danger = row.tone === "danger";
  const ink = inert ? COLORS.inkMuted : danger ? COLORS.seal : COLORS.inkSoft;
  const iconInk = inert ? COLORS.inkMuted : danger ? COLORS.seal : COLORS.inkMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={row.hint}
      accessibilityState={{ disabled: inert }}
      disabled={inert}
      onPress={target === null ? undefined : () => onGo(target)}
      style={(state) => [
        styles.primaryAction,
        danger ? styles.primaryActionDanger : null,
        pressedOpacity(state),
      ]}
    >
      {row.icon === null ? null : <Icon name={row.icon} size="sm" color={iconInk} />}
      <View style={styles.primaryTextCol}>
        <Text numberOfLines={1} style={[styles.primaryLabel, { color: ink }]}>
          {row.label}
        </Text>
        {row.caption === null ? null : <Text style={styles.primaryCaption}>{row.caption}</Text>}
      </View>
    </Pressable>
  );
}

/**
 * One group: its heading, then its rows.
 *
 * THE HEADING IS A HEADER TO A SCREEN READER, so TalkBack can move group to
 * group instead of reading fifteen rows as one list. Sentence case in the
 * catalogue and uppercase in style (`Eyebrow`), so it is read as a word rather
 * than spelled out.
 *
 * THE CLOSING GROUP HAS NO HEADING, and is drawn after a hairline instead: its
 * one act closes the record, and a heading would make it read as one more
 * category of options.
 */
function ActionGroup({ group, onGo }: { group: OwnerPanelGroup; onGo: Go }) {
  return (
    <View style={styles.group}>
      {group.heading === null ? (
        <View style={styles.separator} />
      ) : (
        <View accessible accessibilityRole="header">
          <Eyebrow>{group.heading}</Eyebrow>
        </View>
      )}
      {group.rows.map((row) => {
        const { target } = row;
        return (
          <ListRow
            key={row.id}
            label={row.label}
            caption={row.caption ?? undefined}
            accessibilityHint={row.hint}
            onPress={target === null ? undefined : () => onGo(target)}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * Full-width stack under the card — same grammar as web `.ln-act` on a
   * narrow phone (icon + label, card surface, strong border). Three equal
   * columns crushed "Modo perdida" on the J7; a stack keeps each act at the
   * credential's own visual weight. A single "Compartir" (deceased / org) is
   * still one full-width act.
   */
  primaryRow: { gap: 10 },
  primaryAction: {
    minHeight: TOUCH_TARGET,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    borderRadius: 10,
    backgroundColor: COLORS.surface,
  },
  primaryActionDanger: { borderColor: COLORS.dangerBorder },
  primaryTextCol: { flex: 1, minWidth: 0, gap: 2 },
  primaryLabel: {
    fontFamily: FONTS.sansSemibold,
    fontSize: 13,
    lineHeight: 13 * LEADING.sm,
  },
  primaryCaption: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.xs,
    color: COLORS.inkMuted,
  },
  group: { gap: SPACE.xs },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.border,
    marginBottom: SPACE.xs,
  },
});

/**
 * The panel's StyleSheet, exported for the render tests — they find the primary
 * row by the style object it was built from, since production stays a11y-only
 * and carries no testID. Production reads `styles`; only the tests read this.
 */
export const ownerActionPanelStyles = styles;
