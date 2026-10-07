// The header's right side on the two screens that carry the menu: the bell, then
// the ☰ (inicio-app-rediseno, PO 2026-10-07).
//
// NOTIFICACIONES IS A BELL NOW, not a row of the menu and not a button at the end
// of the home. The web's citizen masthead draws the same thing
// (`AppCitizenMasthead`): a bell with a red count, capped at "9+". The count is
// `useUnreadCount`'s, and when that read fails the badge is simply not drawn —
// the bell itself always works, it opens the inbox.
//
// GATED, like `HeaderMenuButton` and for its reason: `headerRight` mounts before
// the screen's own `useGate()` decides, and a bell over Splash or
// `UnverifiedScreen` would fire an authenticated read for a session that may not
// reach it. Checked HERE, before the bell mounts, so the hook never reads for a
// refused session.

import { notificationBadgeLabel } from "@dim/contract/api";
import { useRouter } from "expo-router";
import { Bell } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useGate } from "../auth/useGate";
import { useUnreadCount } from "../notifications/use-unread-count";
import { HeaderMenuButton } from "./TopLevelNavMenu";
import { FONTS } from "./fonts";
import { pressedOpacity } from "./kit";
import { ROUTES } from "./routes";
import { COLORS, SPACE, TOUCH_TARGET } from "./theme";

/** What a screen reader hears for the bell. */
export function bellAccessibilityLabel(badge: string | null): string {
  if (badge === null) return "Notificaciones";
  if (badge === "9+") return "Notificaciones, más de 9 sin leer";
  return `Notificaciones, ${badge} sin leer`;
}

export function HeaderActions() {
  const gate = useGate();
  if (!gate.allowed) return null;
  return (
    <View style={styles.row}>
      <NotificationsBell />
      <HeaderMenuButton />
    </View>
  );
}

export function NotificationsBell() {
  const router = useRouter();
  const badge = notificationBadgeLabel(useUnreadCount());
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={bellAccessibilityLabel(badge)}
      accessibilityHint="Abre tus avisos."
      onPress={() => router.push(ROUTES.notificaciones)}
      style={(state) => [styles.bell, pressedOpacity(state)]}
    >
      <View importantForAccessibility="no-hide-descendants">
        <Bell size={24} color={COLORS.ink} strokeWidth={2} />
      </View>
      {badge === null ? null : (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.badge}
          testID="notifications-badge"
        >
          <Text style={styles.badgeLabel}>{badge}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: SPACE.xs / 2 },
  bell: {
    minWidth: TOUCH_TARGET,
    minHeight: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    top: 5,
    right: 4,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: COLORS.danger,
    alignItems: "center",
    justifyContent: "center",
    // The ring that separates the dot from the glyph under it — the canvas
    // colour, as on the web masthead.
    borderWidth: 2,
    borderColor: COLORS.canvas,
  },
  badgeLabel: {
    fontFamily: FONTS.monoSemibold,
    fontSize: 11,
    lineHeight: 14,
    color: COLORS.onDark,
  },
});
