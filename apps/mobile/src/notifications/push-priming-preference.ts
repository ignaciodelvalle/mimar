// Whether somebody dismissed the push-notification priming line — "Ahora no" —
// and must not be asked again except from Ajustes.
//
// WHY PER ACCOUNT, LIKE `alta-draft-store.ts` (decision 10A, M-1). A dismissal
// is a choice a PERSON made, not a choice this INSTALL made — the same phone
// can carry two people, and the second one signing in has never seen the
// priming line at all. Keying by owner id is the fence a shared phone needs,
// the same reasoning `alta-draft-store.ts`'s header gives for its own key.
//
// WHY AsyncStorage AND NOT SecureStore, the same three-part answer
// `qr-spotlight-preference.ts` and `alta-draft-store.ts` already give: a
// dismissal grants nothing, it is not worth the Keystore's budget, and the
// disclosure — "this account was once shown a priming line and said not now" —
// is bounded and harmless.
//
// A REFUSED READ MEANS "NOT DISMISSED", NOT "DISMISSED". The safe direction
// when storage will not answer is to offer the priming again rather than to
// silently withhold it forever — an over-eager ask is recoverable with one more
// tap of "Ahora no"; a priming line that can never be reached again because a
// single read failed is not.

import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY_PREFIX = "mimar.pushPriming.dismissed.";

/** The one place the key is spelled. Never build one by hand. */
export function pushPrimingDismissedKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

/** Has this account already said "Ahora no"? Any failure reads as `false`. */
export async function readPushPrimingDismissed(userId: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(pushPrimingDismissedKey(userId))) === "1";
  } catch {
    return false;
  }
}

/**
 * Records the dismissal. Best-effort, like every other preference write in
 * this app: a storage failure must not stop the person from leaving the alta
 * wizard, it just means they may see the priming line again next time.
 */
export async function writePushPrimingDismissed(userId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(pushPrimingDismissedKey(userId), "1");
  } catch {
    // Intentionally silent — see the docblock.
  }
}
