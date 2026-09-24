// `/notificaciones` — la bandeja.
//
// A TOP-LEVEL ROUTE, beside `/mascotas` and `/transferencias` rather than under
// a pet, because a notification is addressed to a PERSON: some are about an
// animal, several are about an animal this person no longer holds, and some are
// about no animal at all.
//
// THE PATH DELIBERATELY MATCHES THE WEB'S, as `/transferencias` and `/cuidado`
// do — and for a reason that is coming rather than one that is here: nothing
// links INTO this screen from outside today (`DEEP_LINK_MAP` has no
// `notifications` row, because nothing outside the rendering surface names it),
// but a push notification opening the inbox is exactly what WU-Q-2 is, and a
// path that already agrees with the web's is one less thing to reconcile when it
// lands.
//
// The route is a thin shell: it refuses to render without a session and hands
// off. Every rule about which affordances a row may offer lives on the server.

import { useRouter } from "expo-router";

import { useGate } from "../src/auth/useGate";
import { NotificationsScreen } from "../src/notifications/NotificationsScreen";
import { ROUTES } from "../src/ui/routes";

export default function NotificacionesRoute() {
  const gate = useGate();
  const router = useRouter();

  if (!gate.allowed) return gate.element;

  return (
    <NotificationsScreen
      // The routes pushed here are already IN-APP paths: a CTA's came from
      // `appRoutePath` on the server (null when the app has no screen, in which
      // case the screen never offers the tap) and a pet link's came from
      // `credentialRoute`. Nothing web-shaped reaches this cast.
      onOpenRoute={(route) => router.push(route as Parameters<typeof router.push>[0])}
      // `dismissTo` (NAV-4): the empty inbox's way out. The pet list is nearly
      // always the screen the inbox was opened from, and pushing a second copy
      // of it leaves a back button that walks through the notifications again.
      onOpenPets={() => router.dismissTo(ROUTES.misMascotas)}
    />
  );
}
