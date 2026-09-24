// AsyncStorage, bound to the marker-store port `launch-update-gate.ts` declares.
//
// ITS OWN FILE FOR THE REASON `expo-updates-port.ts` IS. `@react-native-async-
// storage/async-storage` resolves its native module at import time and THROWS
// under Jest when nothing mocks it ("NativeModule: AsyncStorage is null") — so
// a decision module that imported it would drag that throw into every test of
// the pure functions, which is the reason the port exists at all. The rule and
// the phases stay in `launch-update-gate.ts`; the two lines that touch the
// native module live here, where a file that imports them is opting into the
// native dependency knowingly.
//
// WHY AsyncStorage AND NOT SecureStore: the marker says "this embedded build
// has already asked once". It is not a secret, and the Keystore is reserved for
// the tokens (`auth/secure-store-auth-storage.ts`, chunked through a 2048-byte
// limit) — the same line `credential-cache.ts` draws for the credential.

import AsyncStorage from "@react-native-async-storage/async-storage";

import type { LaunchGateMarkerStore } from "./launch-update-gate";

export const ASYNC_STORAGE_MARKER_STORE: LaunchGateMarkerStore = {
  has: async (key) => (await AsyncStorage.getItem(key)) !== null,
  write: async (key) => {
    await AsyncStorage.setItem(key, "1");
  },
};
