// "The network came back" — as an event a screen can act on.
//
// WHY THIS EXISTS (B-05, measured on a device 2026-09-06, shots 137-140)
// ---------------------------------------------------------------------------
// Airplane mode on, pull to refresh on "Mis mascotas", airplane mode off. The
// offline banner cleared in about nine seconds — so the app KNEW the network was
// back — and the list stayed broken until the person found the "Volver a
// intentar" button. Half of that is fixed by keeping the last good payload
// (`reload-state.ts`); this is the other half: the moment the phone can reach
// the server again is the moment to try, and the person should not have to
// notice a banner disappear and translate that into a tap.
//
// A TRANSITION, NOT A STATE. It fires on false → true only. NetInfo emits on
// every change (and `null` means "not sure yet"), so a hook that fired on every
// `isConnected === true` would re-read on the first event after mount, on a
// background/foreground cycle, and on any flap — a read the screens already do
// on focus. What is worth a request is the EDGE: we were definitely offline, and
// now we are definitely not.
//
// SAME NATIVE DEPENDENCY, SAME HONEST DEGRADATION as `OfflineBanner`: with no
// `@react-native-community/netinfo` module under it the listener never fires and
// nothing happens, which is exactly today's behaviour.

import NetInfo from "@react-native-community/netinfo";
import { useEffect, useRef } from "react";

/**
 * Run `onReconnect` when the device goes from definitely-offline to
 * definitely-online.
 *
 * The callback is held in a ref so a screen can pass an inline closure without
 * re-subscribing on every render — the subscription's identity must not depend
 * on the caller's render cycle, or a re-render between the two NetInfo events
 * would lose the transition it is watching for.
 */
export function useReconnect(onReconnect: () => void): void {
  const callback = useRef(onReconnect);
  callback.current = onReconnect;

  useEffect(() => {
    // `null` is "unknown" and must not count as offline — see OfflineBanner.
    let wasOffline = false;
    const unsubscribe = NetInfo.addEventListener((state) => {
      const online = state.isConnected === true;
      if (online && wasOffline) callback.current();
      if (state.isConnected === false) wasOffline = true;
      else if (online) wasOffline = false;
    });
    return unsubscribe;
  }, []);
}
