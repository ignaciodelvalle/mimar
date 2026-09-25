// The persistent top-level nav — U-1 (M2, Samsung J7 2016 / Android 8).
//
// THE PROBLEM. `/mascotas` (the app's most-opened screen) lists every
// top-level destination — Transferencias, Tránsito, Notificaciones, Mis
// turnos, Reclamar, Adoptar, Denunciar, Ajustes — as a FOOTER, below every pet
// card. On a small screen with several pets registered, reaching any of them
// meant scrolling past the whole list first. From the pet detail screen there
// was no way to any of them at all except the hardware back button.
//
// THE DECISION (PO, accepted default): a header menu. A button that sits in
// the native stack header — ABOVE the scrollable body, so it never moves when
// the list scrolls — opens a sheet naming every destination at once. Wired in
// `app/_layout.tsx`'s `headerRight` for `mascotas/index` and
// `mascotas/[publicToken]`, the two screens the footer used to be the only way
// out of.
//
// THE LIST HAS ONE HOME. `TOP_LEVEL_DESTINATIONS` used to be duplicated by
// hand in `app/mascotas/index.tsx`'s footer — same labels, same routes, same
// hints, copied rather than shared — which is exactly the shape a silent
// drift takes: nothing stops one copy from changing without the other. That
// footer now MAPS over this array (see its own file), so there is one list to
// read and one place to change it. The footer stays (nothing reachable before
// is reachable one way fewer now); this menu is the second, scroll-proof door
// to the same eight rooms.
//
// A HAMBURGER, NOT "ellipsis". `OwnerFace.tsx`'s "Más" button already uses
// `Icon name="ellipsis"` for a DIFFERENT menu — this screen's own actions
// (compartir, cuidado, credencial…). Two buttons meaning two different things
// must not wear the same glyph, especially when both can be on screen at
// once (the pet detail screen has both). Three plain bars, drawn with the
// app's own ink colour, cost no new dependency and no new entry in the
// shared `@dim/contract/icons` vocabulary — which the web does not carry this
// button at all, so there is no verbatim web glyph to follow (see that
// table's own header).

import { useRouter } from "expo-router";
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
import { SecondaryButton, pressedOpacity } from "./kit";
import { ROUTES } from "./routes";
import { COLORS, LABEL_TRACKING_EM, RADIUS, SPACE, TOUCH_TARGET, TYPE } from "./theme";

export type TopLevelDestination = {
  label: string;
  route: string;
  accessibilityHint?: string;
  /**
   * THE ONE ITEM THAT NEEDS EXTRA UI THE SHEET DOESN'T. `app/mascotas/
   * index.tsx`'s footer wraps "Denunciar maltrato" in `styles.civicAction`
   * for more space above it than any other button gets — a button that files
   * a criminal allegation must not be reachable by a thumb aiming at the one
   * above it. The header sheet does not need this: a short row list has no
   * "aiming at the wrong button" risk the way eight stacked full-width
   * buttons do. Extending the type (rather than the footer special-casing a
   * label string) is what lets the footer stay data-driven.
   */
  civicAction?: boolean;
};

/**
 * THE TOP-LEVEL DESTINATIONS (nine since M16 added Mis denuncias), in the order
 * `app/mascotas/index.tsx`'s footer has always used — see that file for why
 * Denunciar sits last and Tránsito sits beside Transferencias. Mis denuncias
 * sits right above Denunciar: the list of what you filed beside the act of
 * filing, and `civicAction`'s extra space still falls between the two. This is the ONE array both the footer
 * and this menu render from now; a destination added here appears in both
 * without anyone remembering to copy it twice.
 */
export const TOP_LEVEL_DESTINATIONS: readonly TopLevelDestination[] = [
  {
    label: "Transferencias",
    route: ROUTES.transferencias,
    accessibilityHint: "Propuestas de transferencia recibidas y enviadas.",
  },
  {
    label: "Tránsito",
    route: ROUTES.transito,
    accessibilityHint: "Propuestas de tránsito, y las mascotas que cuidás hoy.",
  },
  {
    label: "Notificaciones",
    route: ROUTES.notificaciones,
    accessibilityHint: "Avisos sobre tus mascotas y tu cuenta.",
  },
  {
    label: "Mis turnos",
    route: ROUTES.turnos,
    accessibilityHint: "Turnos reservados, y el código de check-in de cada uno.",
  },
  {
    label: "Reclamar una mascota",
    route: ROUTES.reclamar,
    accessibilityHint: "Si tu mascota ya está registrada por su microchip o su tatuaje.",
  },
  {
    label: "Adoptar",
    route: ROUTES.adoptar,
    accessibilityHint: "Mascotas publicadas por refugios verificados.",
  },
  {
    label: "Mis denuncias",
    route: ROUTES.misDenuncias,
    accessibilityHint: "Las denuncias que enviaste con tu cuenta, y en qué estado está cada una.",
  },
  {
    label: "Denunciar maltrato",
    route: ROUTES.denunciar,
    accessibilityHint: "Denunciar maltrato o abandono de un animal ante la autoridad. Ley 14.346.",
    civicAction: true,
  },
  { label: "Ajustes", route: ROUTES.ajustes },
];

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
 * The header button + the sheet it opens. One instance is enough for a
 * screen — see `app/_layout.tsx`'s `headerRight` for `mascotas/index` and
 * `mascotas/[publicToken]`.
 *
 * GATED, LIKE THE SCREEN ITS OWN HEADER SITS ON. `headerRight` is the native
 * stack header's, not the screen body's — react-navigation draws it the
 * moment the route mounts, before `mascotas/index.tsx`'s own `useGate()`
 * decides whether to render Splash, `UnverifiedScreen` or the real list. Left
 * unguarded, the hamburger sat over all three: a person mid-splash, or
 * offline with an unverified session, saw a menu into eight screens their
 * session may not even reach. Calling the SAME hook here and rendering
 * nothing when it refuses is cheap — `useGate` reads a synced store, it does
 * not fetch — and it is the one way this component can know what the screen
 * beneath it knows.
 */
export function HeaderMenuButton() {
  const gate = useGate();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { height: windowHeight } = useWindowDimensions();

  const close = useCallback(() => setOpen(false), []);

  // THE DOUBLE-TAP GUARD. `Modal`'s `visible={false}` does not unmount its
  // content the instant this component asks it to — the fade-out plays first,
  // and RN's own `Modal.js` keeps `isRendered` (hence the rows) mounted until
  // the native dismiss fires. A second tap landing on the same row during
  // that window called `router.push` a second time with the SAME route. The
  // ref (not state) is deliberate: it must read the CURRENT value inside a
  // `Pressable.onPress` closure created at the previous render, which a
  // `useState` value captured by that same closure cannot do.
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
        accessibilityHint="Lista Transferencias, Tránsito, Notificaciones, Mis turnos, Reclamar, Adoptar, Mis denuncias, Denunciar y Ajustes."
        onPress={openMenu}
        style={styles.trigger}
      >
        <HamburgerGlyph />
      </Pressable>

      <Modal animationType="fade" onRequestClose={close} transparent visible={open}>
        {/* THE BACKDROP IS A SIBLING OF THE SHEET, not its wrapper. It used to
            wrap the sheet, which made VoiceOver read the whole overlay —
            backdrop AND every row inside it — as ONE opaque element, and left
            TalkBack landing on an unlabelled node first. An absolute-fill
            sibling closes the sheet on its own tap (RN's touch dispatch gives
            the touch to whichever view is drawn on top at that point, and the
            sheet — rendered after, so painted over the backdrop — wins on its
            own rectangle) without sitting between the accessibility tree and
            the sheet's rows. */}
        {/* `accessibilityViewIsModal` LIVES HERE, ON THE CONTAINER OF BOTH —
            not on `sheet` alone. `accessibilityViewIsModal` hides every HOST
            SIBLING of the view that carries it (that is how VoiceOver's own
            "stay inside the modal" behaves, and RNTL's `isSubtreeInaccessible`
            models it exactly that way). Putting it on `sheet` made the
            backdrop close button — `sheet`'s OWN sibling — invisible to
            VoiceOver AND to `getByLabelText` in this file's own tests: the one
            way a screen-reader user had to dismiss the sheet would have been
            the one control they could not reach. Here, on the shared parent,
            it isolates the whole overlay from the (already native-modal-
            isolated) rest of the app, and leaves the backdrop and the sheet
            as un-hidden children of each other's ancestor. */}
        <View accessibilityViewIsModal style={styles.overlay}>
          <Pressable
            accessibilityLabel="Cerrar menú"
            accessibilityRole="button"
            onPress={close}
            style={StyleSheet.absoluteFill}
          />
          {/* `accessible={false}`: a CONTAINER, not one opaque element — every
              row below is its own accessibility node again. */}
          <View accessible={false} style={styles.sheet}>
            <Text style={styles.sheetTitle}>Ir a…</Text>
            {/* A `maxHeight` CAP, not a fixed height (B-08's own argument,
                `kit.tsx`'s `PasswordField` note) — at the largest font scale
                eight rows plus the title can exceed the screen, and a sheet
                that just grew off the top and bottom clipped the last few
                rows with no way to reach them. Capped at 70% of the window and
                scrollable past that; short of the cap this scrolls nothing,
                so ordinary font scales see no change. */}
            <ScrollView style={{ maxHeight: windowHeight * 0.7 }}>
              {TOP_LEVEL_DESTINATIONS.map((destination) => (
                <Pressable
                  key={destination.route}
                  accessibilityHint={destination.accessibilityHint}
                  accessibilityLabel={destination.label}
                  accessibilityRole="button"
                  onPress={() => selectDestination(destination.route)}
                  style={(state) => [styles.row, pressedOpacity(state)]}
                >
                  <Text style={styles.rowLabel}>{destination.label}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

/**
 * THE SECOND, SCROLL-BOUND DOOR (see the file header): the footer that lists
 * every `TOP_LEVEL_DESTINATIONS` entry as a full-width button, one stacked
 * per row. Lives here — beside the array it renders — rather than in
 * `app/mascotas/index.tsx`, because `MisMascotasScreen` (2026-09-24, M3 / R-1
 * review) needs it TWICE: once inside the loaded arm's `FlatList` footer, and
 * once in the loading/failed arms, which render on the shared `Screen`
 * instead. Those two arms used to only get this footer in the loaded case —
 * a person offline on first open saw an `ErrorNotice` and NOTHING ELSE, no
 * way out of the screen but the hardware back button, which is exactly the
 * gap this component's own header menu exists to close on the OTHER two
 * screens. One component used in both places means a destination added here
 * cannot silently reach only one of them.
 */
export function DestinationsFooter() {
  const router = useRouter();
  return (
    <View style={styles.footer}>
      {TOP_LEVEL_DESTINATIONS.map((destination) =>
        destination.civicAction ? (
          <View key={destination.route} style={styles.civicAction}>
            <SecondaryButton
              accessibilityHint={destination.accessibilityHint}
              label={destination.label}
              onPress={() => router.push(destination.route)}
            />
          </View>
        ) : (
          <SecondaryButton
            key={destination.route}
            accessibilityHint={destination.accessibilityHint}
            label={destination.label}
            onPress={() => router.push(destination.route)}
          />
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // `DestinationsFooter`'s own layout. `civicAction` carries the WHY: see
  // `TopLevelDestination.civicAction`'s docblock above.
  footer: { marginTop: SPACE.lg, gap: SPACE.sm },
  civicAction: { marginTop: SPACE.sm },
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
  sheetTitle: {
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * LABEL_TRACKING_EM,
    textTransform: "uppercase",
    color: COLORS.inkMuted,
    paddingTop: SPACE.sm,
    paddingBottom: SPACE.xs,
  },
  row: {
    minHeight: TOUCH_TARGET,
    justifyContent: "center",
    borderTopWidth: 1,
    borderTopColor: COLORS.borderSoft,
  },
  rowLabel: { fontFamily: FONTS.sansMedium, fontSize: TYPE.md, color: COLORS.ink },
});
