// The header bell's number (inicio-app-rediseno, PO 2026-10-07).
//
// ITS OWN READ, AND ITS FAILURE HAS NO NUMBER. `GET /me/notifications/
// unread-count` answers the whole inbox's unread aggregate. When that read
// fails — offline, a 503, a refused session — this hook answers `null` and the
// bell draws NO badge. Never a "0" it did not receive: a badge that says nothing
// is waiting while the read failed is the one lie this control could tell.
//
// RE-READ ON FOCUS, WITHOUT `useFocusEffect`. The bell lives in the native
// stack's `headerRight`, which react-navigation renders OUTSIDE the screen's
// own navigation context (the native stack hands only the header-height and
// back-button contexts down to it), so `useFocusEffect` there would bind to
// the root container and never fire again. What IS readable from a header is
// expo-router's global pathname. The hook remembers the path its screen was
// mounted on and re-reads every time the pathname comes back to it — which is
// exactly "the screen got focus again", including the case the review names:
// coming back from Notificaciones after reading some, where the badge has to
// drop. Navigating AWAY reads nothing.
//
// A READ THAT RESOLVES AFTER A NEWER ONE STARTED IS DROPPED (the same
// generation guard every list on the home uses), and nothing is written after
// the component unmounts.

import { usePathname } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { fetchMyUnreadNotificationCount } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";

export function useUnreadCount(): number | null {
  const pathname = usePathname();
  // The path of the screen whose header holds this bell — the first one seen.
  const hostPath = useRef<string | null>(null);
  if (hostPath.current === null) hostPath.current = pathname;

  const [count, setCount] = useState<number | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const result = await fetchMyUnreadNotificationCount(sessionPort);
      if (mine !== generation.current) return;
      setCount(result.outcome === "ok" ? result.payload.unreadCount : null);
    } catch {
      // A request that THROWS instead of answering is a failed read too: the
      // old number must not stay on the badge (`use-pending-incoming.ts` swallows
      // a throw the same way — a badge is never worth a crash in the header).
      if (mine === generation.current) setCount(null);
    }
  }, []);

  useEffect(() => {
    if (pathname === hostPath.current) void refresh();
  }, [pathname, refresh]);

  // Unmounting invalidates whatever is in flight.
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  return count;
}
