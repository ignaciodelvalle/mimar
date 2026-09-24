// Haptic punctuation for the moments that matter in the hand.
//
// QOL 2026-09-01: the web gets its outcome feedback from toasts and focus
// moves; a phone has one channel the web does not — the hand holding it. Three
// verbs, mapped to what the OS vocabularies already mean:
//
//   success — an async operation the person WAITED for came back changed
//             (a pet registered, a search command taken, a turno reserved).
//   error   — the same wait came back as a refusal. Pairs with the visible
//             error surface; it never replaces one.
//   confirm — a physical tap acknowledging a WEIGHTY step just armed (the
//             "¿Confirmás?" before closing a search), distinct from an outcome.
//
// FIRE-AND-FORGET, EVERY ONE. Haptics are punctuation: an emulator, a web
// build, or a device with no vibration engine rejects the promise, and
// feedback about feedback is not an error anybody can act on. Nothing may
// await these or branch on them.

import * as Haptics from "expo-haptics";

export function hapticSuccess(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}

export function hapticError(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
}

export function hapticConfirm(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}
