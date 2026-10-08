// /aviso/{notificationId} — one notification's destination, resolved by the
// server at tap time (notificaciones-destinos, 2026-10). A thin shell: it
// validates the path parameter, refuses to render without a session, and hands
// off to `NotificationTargetScreen`.
//
// Opened from an inbox row (`?origen=bandeja`, `notificationDetailRoute`) it is
// the notification's detail instead: the whole body, the CTA, "Archivar".
//
// "aviso" and not "notificaciones/{id}": the inbox is the FILE
// `app/notificaciones.tsx`, and a sibling folder of the same name is an
// arrangement this router's layout does not need to learn for one screen.

import { useLocalSearchParams, useRouter } from "expo-router";
import { Linking } from "react-native";

import { useGate } from "../../src/auth/useGate";
import { API_BASE_URL } from "../../src/config/api";
import { NotificationTargetScreen } from "../../src/notifications/NotificationTargetScreen";
import {
  inboxDetailFromParams,
  webOnlyUrl,
} from "../../src/notifications/notification-target-view-model";
import { ErrorNotice } from "../../src/ui/components";
import { Screen } from "../../src/ui/kit";
import { ROUTES } from "../../src/ui/routes";

export default function AvisoRoute() {
  const gate = useGate();
  const router = useRouter();
  const params = useLocalSearchParams<{
    notificationId?: string | string[];
    origen?: string | string[];
    accion?: string | string[];
    mascota?: string | string[];
    nombre?: string | string[];
  }>();

  if (!gate.allowed) return gate.element;

  const raw = params.notificationId;
  const notificationId = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  if (notificationId.length === 0) {
    return (
      <Screen>
        <ErrorNotice message="Este link no apunta a una notificación. Abrí tus notificaciones y entrá desde ahí." />
      </Screen>
    );
  }

  return (
    <NotificationTargetScreen
      notificationId={notificationId}
      // A row of the inbox opens this screen with `origen=bandeja` and gets the
      // notification's detail; a push tap does not, and is routed straight on.
      inbox={inboxDetailFromParams(params)}
      onOpenRoute={(route) => router.push(route as Parameters<typeof router.push>[0])}
      // The route came from the server's resolver, built from the same contract
      // this build carries — an in-app path, never a web one.
      onReplace={(route) => router.replace(route as Parameters<typeof router.replace>[0])}
      onOpenWeb={(target) => {
        const url = webOnlyUrl(API_BASE_URL, target);
        if (url !== null) void Linking.openURL(url);
      }}
      // Validated http(s) by the view-model before it gets here.
      onOpenExternal={(url) => void Linking.openURL(url)}
      onOpenInbox={() => router.dismissTo(ROUTES.notificaciones)}
    />
  );
}
