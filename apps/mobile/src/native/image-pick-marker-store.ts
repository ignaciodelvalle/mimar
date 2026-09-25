// AsyncStorage, bound to the marker store `image-picker-port.ts` declares.
//
// ITS OWN FILE FOR THE REASON `launch-gate-marker-store.ts` IS. `@react-
// native-async-storage/async-storage` resolves its native module at import
// time and throws under Jest when nothing mocks it. Keeping the three calls
// that touch it here means `image-picker-port.ts` stays native-free and
// testable with a fake store, the same split `runLaunchUpdateGate` and its
// marker store already draw.
//
// WHY AsyncStorage AND NOT SecureStore: the same line every other marker in
// this app draws (`launch-gate-marker-store.ts`, `qr-spotlight-preference.ts`,
// `event-draft-store.ts`) — this is not a secret, it is a pointer to a pick
// that already happened on this unlocked device. The Keystore is reserved for
// the tokens.
//
// ONE MARKER, NOT ONE PER SCREEN OR PET, because the native module itself
// (`ImagePicker.getPendingResultAsync`) holds at most one pending result at a
// time — see the adapter's header. A second key per screen would just be a
// second place for the same fact to go stale.

import AsyncStorage from "@react-native-async-storage/async-storage";

import type { ImagePickMarker, ImagePickMarkerStore } from "./image-picker-port";

export const IMAGE_PICK_MARKER_KEY = "mimar.imagePick.marker.v1";

/** `true` for the exact shape `ImagePickMarker` requires. Anything else —
 *  a value from a future version of this app, a corrupt write, a leftover
 *  from a build that keyed the marker differently — is treated as absent
 *  rather than guessed at. */
function isImagePickMarker(value: unknown): value is ImagePickMarker {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.screen === "pet-photo" ||
      candidate.screen === "tattoo" ||
      candidate.screen === "post_adoption_checkin") &&
    typeof candidate.publicToken === "string" &&
    typeof candidate.sessionUserId === "string" &&
    typeof candidate.launchedAt === "number"
  );
}

export const ASYNC_IMAGE_PICK_MARKER_STORE: ImagePickMarkerStore = {
  async read() {
    const raw = await AsyncStorage.getItem(IMAGE_PICK_MARKER_KEY);
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isImagePickMarker(parsed) ? parsed : null;
    } catch {
      return null;
    }
  },
  async write(marker) {
    await AsyncStorage.setItem(IMAGE_PICK_MARKER_KEY, JSON.stringify(marker));
  },
  async clear() {
    await AsyncStorage.removeItem(IMAGE_PICK_MARKER_KEY);
  },
};
