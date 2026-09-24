// WHAT HAPPENS WHEN SOMEBODY TAPS THE NOTIFICATION.
//
// Until this file existed the answer was "the app opens". The server has been
// putting the destination in `data.url` since the sender was written
// (`messageFor`, lib/infra/expo-push.ts), and nothing on this side read it — so
// an urgent notification about one animal opened whatever screen the app
// happened to be showing, and the person had to find the row in the inbox
// themselves. That is most of the value of a push notification, spent.
//
// ---------------------------------------------------------------------------
// TWO ARRIVALS, AND THE SECOND ONE IS THE COMMON ONE
// ---------------------------------------------------------------------------
// A tap reaches an app that is RUNNING through a listener. A tap reaches an app
// that is NOT running through neither — the response happens before the JS
// runtime exists, and by the time any listener could be attached it is already
// in the past. The module holds that one and answers `lastTap()`.
//
// The cold start is not the edge case. A phone that has been quiet long enough
// for a notification to matter is a phone whose app was swiped away days ago. A
// tap handler that only subscribes works perfectly in every manual test — where
// the app is always already open — and fails for almost every real person.
//
// ---------------------------------------------------------------------------
// WHY THE WEB PATH IS RESOLVED HERE AND NOT ON THE SERVER
// ---------------------------------------------------------------------------
// `data.url` carries the notification's `cta_url`, which is a WEB path
// (`/mis-mascotas/DIM-PAMP-0001`). The inbox endpoint resolves the same column
// to a native route server-side (app/api/v1/me/notifications/payload.ts), and
// this deliberately does not follow it.
//
// The difference is WHEN the two are computed. The inbox payload is built per
// request, by a server that is answering the build in front of it right now. A
// push payload is written once, at send time, and then sits on a device — for
// minutes or for a day — belonging to whatever build happens to be installed. A
// server that resolved the route would be deciding which screens a phone has
// from the wrong side of a store release: a route added this month, sent to a
// build from last month, is a deep link into nothing. Resolving here means the
// mapping always travels with the code that has to render it, and an
// unrecognised destination degrades to "just open the app" instead of to a blank
// stack.
//
// It also keeps `data.url` meaningful to anything else that ever reads it, and
// keeps the generic-payload rule intact: the deep link survives genericisation
// precisely because it is not rendered.

import { useEffect } from "react";

import { useRouter } from "expo-router";

import { type DeepLinkName, appRoutePath, matchWebPath } from "@dim/contract/links";

import { type PushTap, lastPushTapSafely, onPushTapSafely } from "../native/push-port";

/**
 * `appRoutePath` with the destination name coming out of a runtime match rather
 * than a literal.
 *
 * The same widening `payload.ts` performs, for the same reason and with the same
 * caveat: the generic signature exists so a caller writing a name it knows gets
 * its placeholders checked, and here the name is whatever `matchWebPath`
 * returned, so there is nothing to check. The params handed over are exactly the
 * ones that pattern produced.
 */
const resolveAppRoute = appRoutePath as (
  name: DeepLinkName,
  params: Record<string, string>,
) => string | null;

/**
 * The in-app route a tapped notification should open, or `null` to stay put.
 *
 * `null` IS A NORMAL, FREQUENT ANSWER and not an error, which is why nothing
 * reports it. Four different things produce it and all four are ordinary:
 *
 *   · the notification carried no CTA at all (most types do not);
 *   · its `cta_url` is an absolute `https://` link to somewhere else entirely —
 *     `matchWebPath` refuses those by construction rather than matching another
 *     origin's path against our table;
 *   · the destination exists on the web and has no screen in this app, which is
 *     most of the deep-link table and will stay that way;
 *   · this build predates the destination.
 *
 * In every one of them the right behaviour is the same: the app opens, at
 * whatever the gate decides, and the person finds the notification in the inbox.
 * A tap that opens the app is already the outcome they asked for.
 *
 * IT DOES NOT CHECK WHETHER THE PERSON MAY SEE THE SCREEN, deliberately. Every
 * screen in this app decides that for itself with `useGate`, evaluated by the
 * same render that would otherwise draw the protected content — so a deep link
 * into somebody else's pet, or into any screen at all while signed out, resolves
 * to the gate's redirect with no frame in which anything private is visible. A
 * second authorization decision here would be a copy of that rule with nothing
 * keeping the two in agreement.
 */
export function appRouteForPushUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  const destination = matchWebPath(url);
  if (destination === null) return null;
  return resolveAppRoute(destination.name, destination.params);
}

/**
 * Whether this tap has already been acted on.
 *
 * IT IS MODULE STATE BECAUSE THE PROBLEM IS, and a ref would not have reached
 * far enough. `getLastNotificationResponseAsync` keeps answering the SAME
 * response for the whole life of the process — it is a held value, not a queue —
 * so anything that asks twice navigates twice. React in development mounts
 * effects twice on purpose, and a layout that remounted for any other reason
 * would do it again; both would yank somebody off the screen they had navigated
 * to in the meantime, seconds after they got there. One flag per process, which
 * is exactly the scope of the value it is guarding.
 */
let launchTapHandled = false;

/** Forgets that the launch tap was handled. For tests, which share a registry. */
export function resetPushTapHandling(): void {
  launchTapHandled = false;
}

/**
 * Route every tap, from both arrivals, for the life of the app.
 *
 * MOUNTED ONCE, IN THE ROOT LAYOUT, and it has to be a hook rather than a
 * module-scope subscription for one reason: navigating needs a router, and the
 * router does not exist until the layout that provides it has rendered. A
 * `router.push` fired at module scope — which is where the rest of the push seam
 * is wired — would be a call into a navigator that is not mounted yet.
 *
 * `push` AND NOT `replace`, so Android's back button unwinds INTO the app
 * instead of out of it. The root layout's `anchor` (see `app/_layout.tsx`) is
 * what puts a screen underneath a one-deep stack; `replace` would discard that
 * and hand the person a back button that quits.
 *
 * THE LAUNCH TAP IS READ ASYNCHRONOUSLY AND MAY LAND AFTER THE FIRST PAINT, and
 * that is accepted rather than worked around. The alternative is holding the
 * splash until the module answers, which would delay every ordinary cold start
 * — the overwhelming majority — to spare a notification tap one frame of the
 * app's own home screen.
 */
export function usePushTapNavigation(): void {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;

    const go = (tap: PushTap): void => {
      const route = appRouteForPushUrl(tap.url);
      if (route === null) return;
      router.push(route as never);
    };

    // The tap that started this process, if one did.
    if (!launchTapHandled) {
      launchTapHandled = true;
      void lastPushTapSafely().then((tap) => {
        if (cancelled || tap === null) return;
        go(tap);
      });
    }

    // And every tap from here on: from the background, and from the foreground
    // banner the adapter's handler draws.
    const unsubscribe = onPushTapSafely(go);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [router]);
}
