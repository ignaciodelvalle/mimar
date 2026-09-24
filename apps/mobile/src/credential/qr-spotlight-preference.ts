// Whether the credential screen is allowed to raise the screen brightness.
//
// ITS OWN FILE FOR THE REASON `launch-gate-marker-store.ts` IS. `@react-native-
// async-storage/async-storage` resolves its native module at import time and
// throws under Jest when nothing mocks it ("NativeModule: AsyncStorage is
// null"). Keeping the two lines that touch it here means `use-qr-spotlight.ts`
// stays a pure hook over a boolean, and its test does not have to know that a
// preference exists at all.
//
// WHY A PREFERENCE AND NOT A CONSTANT (a11y audit 2026-09-16): opening the
// credential drove the screen to full brightness with no way out. For someone
// with photophobia, a migraine, or simply reading in bed, the only escape was
// to leave the screen they were trying to show. A person who turns this off is
// not disabling a feature, they are declining a glare, and the phone should
// remember that rather than ask again at every counter.
//
// DEFAULT ON. The spotlight earns its place: a dim screen is a QR a camera in
// the street cannot read. The default is the behaviour that existed before this
// preference, so nobody who never opens the control notices a change.
//
// NOT A SECRET, so AsyncStorage rather than SecureStore — the same line
// `credential-cache.ts` and the launch-gate marker already draw.

import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "credential.qrSpotlight";

/** Reads the stored choice. Any failure, and any absence, means ON. */
export async function readQrSpotlightPreference(): Promise<boolean> {
  try {
    // Only an explicit "off" turns it off. A corrupt or unexpected value is
    // treated as never-chosen, because the safe direction here is the readable
    // QR, not the dark one.
    return (await AsyncStorage.getItem(KEY)) !== "off";
  } catch {
    return true;
  }
}

/**
 * Stores the choice. Best-effort: a storage failure must not stop the screen
 * from honouring the choice for as long as it is open — the caller has already
 * applied it to its own state by the time this runs.
 */
export async function writeQrSpotlightPreference(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, enabled ? "on" : "off");
  } catch {
    // Intentionally silent. See the docblock.
  }
}
