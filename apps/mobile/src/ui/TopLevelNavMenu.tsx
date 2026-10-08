// The app's menu — the ☰ in the native header (inicio-app-rediseno, PO 2026-10-07).
//
// WHAT IT REPLACED. Until this change `/mascotas` ended in nine full-width
// buttons of identical weight (Transferencias, Tránsito, Notificaciones, Mis
// turnos, Reclamar, Adoptar, Mis denuncias, Denunciar maltrato, Ajustes), and
// this menu was "the second, scroll-proof door to the same eight rooms" — the
// same nine rows, flat, in the same order. Two doors to every room and neither
// one ordered. The PO approved the redesign in
// `dim-interno:docs/reviews/2026-10-home-app/rediseno-home.html`:
//
//   · THE ☰ IS THE ONLY DOOR to what is used now and then. The footer is gone
//     from the home (`DestinationsFooter` and its `civicAction` spacing were
//     deleted with it — the spacing was a patch over stacking a criminal
//     allegation under eight look-alike buttons, a problem a grouped list of
//     rows does not have).
//   · FOUR GROUPS, each with a header TalkBack reads as one
//     (`accessibilityRole="header"`): Mis mascotas, Turnos y casos, Comunidad,
//     Cuenta. Every row has an icon, and a caption where the name alone does not
//     say what is behind it (the old `accessibilityHint`, now visible).
//   · NOTIFICACIONES LEFT THE MENU. It is the bell beside the ☰ now, with an
//     unread badge (`HeaderActions.tsx`).
//   · "MIS CASOS" IS A ROW. The open-cases block on the home is drawn only while
//     something is open, and its "Ver todos mis casos" link was the only way to
//     `/casos` — so with nothing open, the history of closed cases had no door.
//   · "DENUNCIAS" IS ONE ROW, the list, as the web's OWNER_NAV names it (PO
//     2026-07-03); filing a new one is the primary action at the top of that list.
//   · "REGISTRAR" AND "RECLAMAR" ARE NOT HERE: their one door is "+ Agregar" on
//     the home's "Tus mascotas" row (`AddPetAction`).
//
// ONE SOURCE. `NAV_SECTIONS` is the only list of destinations in the app — it
// replaced `TOP_LEVEL_DESTINATIONS` — so a destination added here has exactly
// one place to appear and nothing to drift from (AGENTS rule 7's principle).
//
// A HAMBURGER, NOT "ellipsis". `OwnerFace.tsx`'s "Más" button already uses
// `Icon name="ellipsis"` for a DIFFERENT menu — the pet screen's own actions.
// Two buttons meaning two different things must not wear the same glyph,
// especially when both can be on screen at once (the pet screen has both).
//
// THE ICONS ARE EXPLICIT `lucide-react-native` IMPORTS, the way
// `HeaderBackButton.tsx` imports its chevron — not entries in the shared
// `@dim/contract/icons` table, which names the WEB's pet-profile vocabulary and
// carries nothing for app navigation. lucide-react-native is JS over the
// already-linked react-native-svg, so these imports do not move the native
// fingerprint (see `Icon.tsx`'s header).

import { useRouter } from "expo-router";
import {
  ArrowLeftRight,
  Calendar,
  ChevronRight,
  Flag,
  Folder,
  Heart,
  Home,
  type LucideIcon,
  User,
} from "lucide-react-native";
import { useCallback, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import { useGate } from "../auth/useGate";
import { FONTS } from "./fonts";
import { pressedOpacity } from "./kit";
import { ROUTES } from "./routes";
import { COLORS, LABEL_TRACKING_EM, LEADING, RADIUS, SPACE, TOUCH_TARGET, TYPE } from "./theme";

export type NavDestination = {
  label: string;
  route: string;
  /** Drawn under the label, and read as the row's hint. Only where the name alone is not enough. */
  caption?: string;
  /** Read by a screen reader when there is no caption to read instead. */
  accessibilityHint?: string;
  icon: LucideIcon;
};

export type NavSection = {
  title: string;
  destinations: readonly NavDestination[];
};

/**
 * EVERY DESTINATION OF THE MENU, grouped — the order and the words are the
 * PO-approved design (section c of the review). Eight rows in four groups.
 */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    title: "Mis mascotas",
    destinations: [
      {
        label: "Transferencias",
        route: ROUTES.transferencias,
        caption: "Recibidas, enviadas y pedidos de cuidado",
        icon: ArrowLeftRight,
      },
      {
        label: "Tránsito",
        route: ROUTES.transito,
        caption: "Si cuidás animales de un refugio",
        icon: Home,
      },
    ],
  },
  {
    title: "Turnos y casos",
    destinations: [
      {
        label: "Mis turnos",
        route: ROUTES.turnos,
        accessibilityHint: "Turnos reservados, y el código de check-in de cada uno.",
        icon: Calendar,
      },
      {
        label: "Mis casos",
        route: ROUTES.casos,
        caption: "Abiertos y cerrados",
        icon: Folder,
      },
    ],
  },
  {
    title: "Comunidad",
    destinations: [
      {
        label: "Adoptar",
        route: ROUTES.adoptar,
        caption: "Refugios verificados y tus postulaciones",
        icon: Heart,
      },
      {
        label: "Denuncias",
        route: ROUTES.misDenuncias,
        caption: "Denunciar maltrato y seguir las tuyas",
        icon: Flag,
      },
    ],
  },
  {
    title: "Cuenta",
    destinations: [
      {
        label: "Ajustes",
        route: ROUTES.ajustes,
        caption: "Tus datos, avisos al celular, cerrar sesión",
        icon: User,
      },
    ],
  },
];

/** Every destination, flattened in menu order. For tests and for the one-door rule. */
export const NAV_DESTINATIONS: readonly NavDestination[] = NAV_SECTIONS.flatMap(
  (section) => section.destinations,
);

/** Three bars — see the file header for why this is not `Icon name="ellipsis"`. */
function HamburgerGlyph() {
  return (
    <View style={styles.hamburger} importantForAccessibility="no-hide-descendants">
      <View style={styles.bar} />
      <View style={styles.bar} />
      <View style={styles.bar} />
    </View>
  );
}

/**
 * The header button + the sheet it opens. Rendered by `HeaderActions`, beside
 * the bell, on `mascotas/index` and `mascotas/[publicToken]`.
 *
 * GATED, LIKE THE SCREEN ITS OWN HEADER SITS ON. `headerRight` is the native
 * stack header's, not the screen body's — react-navigation draws it the moment
 * the route mounts, before the screen's own `useGate()` decides whether to
 * render Splash, `UnverifiedScreen` or the real list. Rendering nothing when the
 * same hook refuses is cheap (it reads a synced store, it does not fetch) and is
 * the one way this component can know what the screen beneath it knows.
 */
export function HeaderMenuButton() {
  const gate = useGate();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { height: windowHeight } = useWindowDimensions();

  const close = useCallback(() => setOpen(false), []);

  // THE DOUBLE-TAP GUARD. `Modal`'s `visible={false}` does not unmount its
  // content the instant this component asks it to — the fade-out plays first,
  // and RN's own `Modal.js` keeps the rows mounted until the native dismiss
  // fires. A second tap landing on the same row during that window called
  // `router.push` a second time with the SAME route. A ref (not state), because
  // it must read the CURRENT value inside a closure created at the previous
  // render.
  const navigatedRef = useRef(false);

  const openMenu = useCallback(() => {
    navigatedRef.current = false;
    setOpen(true);
  }, []);

  const selectDestination = useCallback(
    (route: string) => {
      if (navigatedRef.current) return;
      navigatedRef.current = true;
      close();
      router.push(route);
    },
    [close, router],
  );

  if (!gate.allowed) return null;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Abrir menú de navegación"
        accessibilityHint="Transferencias, turnos, casos, adopción, denuncias y ajustes, en cuatro grupos."
        onPress={openMenu}
        style={styles.trigger}
      >
        <HamburgerGlyph />
      </Pressable>

      <Modal animationType="fade" onRequestClose={close} transparent visible={open}>
        {/* THE BACKDROP IS A SIBLING OF THE SHEET, not its wrapper: wrapping it
            made VoiceOver read the whole overlay as ONE opaque element. An
            absolute-fill sibling closes the sheet on its own tap (the sheet,
            painted over it, wins on its own rectangle) without sitting between
            the accessibility tree and the rows.
            `accessibilityViewIsModal` lives on the container of BOTH: on the
            sheet alone it would hide the sheet's own sibling — the backdrop's
            close button, the one way a screen-reader user can dismiss it. */}
        <View accessibilityViewIsModal style={styles.overlay}>
          <Pressable
            accessibilityLabel="Cerrar menú"
            accessibilityRole="button"
            onPress={close}
            style={StyleSheet.absoluteFill}
          />
          {/* `accessible={false}`: a CONTAINER, not one opaque element — every
              row below is its own accessibility node. */}
          <View accessible={false} style={styles.sheet}>
            {/* A `maxHeight` CAP, not a fixed height: at the largest font scale
                four groups of rows with captions exceed the screen, and a sheet
                that grew past the edges clipped the last rows with no way to
                reach them. 85% of the window (the review's number, up from 70%
                for the flat list), scrollable past that; short of the cap this
                scrolls nothing. */}
            <ScrollView style={{ maxHeight: windowHeight * 0.85 }}>
              {NAV_SECTIONS.map((section) => (
                <View key={section.title}>
                  <Text accessibilityRole="header" style={styles.sectionTitle}>
                    {section.title}
                  </Text>
                  {section.destinations.map((destination) => (
                    <NavRow
                      key={destination.route}
                      destination={destination}
                      onPress={selectDestination}
                    />
                  ))}
                </View>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

/** One row: icon, label, the optional caption under it, a chevron. `ListRow`'s anatomy. */
function NavRow({
  destination,
  onPress,
}: {
  destination: NavDestination;
  onPress: (route: string) => void;
}) {
  const RowIcon = destination.icon;
  return (
    <Pressable
      accessibilityHint={destination.caption ?? destination.accessibilityHint}
      accessibilityLabel={destination.label}
      accessibilityRole="button"
      onPress={() => onPress(destination.route)}
      style={(state) => [styles.row, pressedOpacity(state)]}
    >
      <View importantForAccessibility="no-hide-descendants" style={styles.rowIcon}>
        <RowIcon size={20} color={COLORS.inkSoft} strokeWidth={1.75} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{destination.label}</Text>
        {destination.caption === undefined ? null : (
          <Text style={styles.rowCaption}>{destination.caption}</Text>
        )}
      </View>
      <View importantForAccessibility="no-hide-descendants">
        <ChevronRight size={16} color={COLORS.inkMuted} strokeWidth={2} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  trigger: {
    minWidth: TOUCH_TARGET,
    minHeight: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  hamburger: { width: 22, gap: 5 },
  bar: { height: 2, borderRadius: 1, backgroundColor: COLORS.ink },
  overlay: {
    flex: 1,
    // 40% of COLORS.ink (`#1b2a33`, LN_COLORS.ink) — the dim behind the sheet.
    // A literal and not a token because RN's `backgroundColor` takes one
    // string; `DocumentChromeNative.tsx` carries the same kind of derived
    // rgba literal for the same reason.
    backgroundColor: "rgba(27, 42, 51, 0.4)",
    justifyContent: "flex-start",
    alignItems: "stretch",
  },
  sheet: {
    marginTop: SPACE.xl3,
    marginHorizontal: SPACE.lg,
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: SPACE.sm,
    paddingHorizontal: SPACE.md,
  },
  sectionTitle: {
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * LABEL_TRACKING_EM,
    textTransform: "uppercase",
    color: COLORS.inkMuted,
    paddingTop: SPACE.md,
    paddingBottom: SPACE.xs,
  },
  row: {
    minHeight: TOUCH_TARGET,
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    paddingVertical: SPACE.xs,
    borderTopWidth: 1,
    borderTopColor: COLORS.borderSoft,
  },
  rowIcon: { width: 22, alignItems: "center" },
  // The column shrinks and wraps; the icon and the chevron keep their width —
  // so at font scale 1.3 the row grows taller instead of clipping its label.
  rowText: { flex: 1, flexShrink: 1, gap: 1 },
  rowLabel: {
    fontFamily: FONTS.sansMedium,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.sm,
    color: COLORS.ink,
  },
  rowCaption: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.sm,
    color: COLORS.inkMuted,
  },
});
