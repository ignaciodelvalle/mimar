// React's view of the session store, plus the two lifecycle effects the SDK
// needs on a phone.
//
// `useSyncExternalStore` rather than a context with `useState`: the store is
// already the source of truth (`client.ts` writes to it from inside a request),
// and mirroring it into component state would create a second copy that is
// briefly wrong every time a background refresh ends a session.

import { useEffect, useSyncExternalStore } from "react";
import { AppState, type AppStateStatus } from "react-native";

import {
  type SessionState,
  bootstrapSession,
  getSessionState,
  subscribeToSession,
} from "./session-store";
import { authClient } from "./supabase-auth";

export function useSession(): SessionState {
  return useSyncExternalStore(subscribeToSession, getSessionState, getSessionState);
}

const getSessionPhase = (): SessionState["phase"] => getSessionState().phase;

/**
 * The session's PHASE only — for a caller that must not re-render on every
 * store write. The snapshot is a string, so a token refresh that replaces the
 * state object without changing the phase is not a change to this hook. The
 * root layout reads it for the launch mark: subscribing it to the whole
 * session re-rendered the app's `<Stack>` on every background refresh.
 */
export function useSessionPhase(): SessionState["phase"] {
  return useSyncExternalStore(subscribeToSession, getSessionPhase, getSessionPhase);
}

/**
 * Mount-once wiring for the whole app. Called by the root layout.
 *
 * TWO THINGS, and the second is easy to leave out and hard to notice missing:
 *
 *   1. Resolve the stored session at start.
 *   2. Run the SDK's refresh timer ONLY while the app is in the foreground.
 *      `autoRefreshToken` schedules a timer; on a phone the process is frozen in
 *      the background, so the timer either never fires or fires late against a
 *      token that already expired. Supabase's own guidance is to drive it from
 *      AppState, and the failure mode without it is the familiar one: the app
 *      works all day while you are using it and signs you out after a night on
 *      the charger.
 */
export function useSessionBootstrap(): void {
  useEffect(() => {
    void bootstrapSession();

    const client = authClient();
    if (client === null) return;

    const apply = (status: AppStateStatus) => {
      if (status === "active") {
        void client.auth.startAutoRefresh();
      } else {
        void client.auth.stopAutoRefresh();
      }
    };

    apply(AppState.currentState);
    const subscription = AppState.addEventListener("change", apply);
    return () => {
      subscription.remove();
      void client.auth.stopAutoRefresh();
    };
  }, []);
}
