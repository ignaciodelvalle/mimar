// `mimar://appointment/{token}` — where the CHECK-IN QR lands when a phone
// follows it (F-8, closing part of the debt `turnos-view-model.ts` and
// `DEEP_LINK_MAP.appointment` both declare).
//
// THIS SCREEN IS NOT THE READER. The QR on `/turnos/{appointmentToken}`
// encodes this exact link as a payload for a front-desk device that does not
// exist yet — see that screen's own header and `turnos-view-model.ts`'s. What
// THIS screen closes is a narrower, real gap: today a phone that follows the
// link anyway — the owner's own camera app recognising `mimar://` and opening
// it, or a vet's phone that happens to have miMAR installed — lands on
// `+not-found`, a page about routing. That is the wrong sentence for someone
// who scanned a QR they were shown, not a link somebody sent them.
//
// NO SESSION, NO LOOKUP, ON PURPOSE. The front desk scanning this on their own
// device is very likely NOT signed in as the pet's owner — may not be signed
// in at all — and the one thing this screen must never do is answer a
// question about WHOSE turno this is to whoever is holding the phone. It reads
// no state and calls no endpoint: the token in the url is never rendered, only
// used to satisfy the route shape `DEEP_LINK_MAP.appointment.appPath` claims.
// A signed-in owner who taps their own QR by mistake gets the same generic
// sentence as anybody else — the alternative (branching on whether a session
// exists) would make the screen's behaviour depend on who is holding it, which
// is exactly the kind of data-shaped signal a front-desk scan must not leak.
//
// "Ir a mis turnos" is offered anyway, because it is a safe, generic exit: it
// is gated on its own (`app/turnos/index.tsx` behind `useGate`), so someone
// signed out lands on ingreso like any other cold navigation there, and it
// tells this screen nothing about who tapped it.

import { useRouter } from "expo-router";

import { Body, Card } from "../../src/ui/components";
import { PrimaryButton, Screen, Title } from "../../src/ui/kit";
import { ROUTES } from "../../src/ui/routes";

export default function AppointmentCheckInLinkRoute() {
  const router = useRouter();
  return (
    <Screen edges={["top", "bottom"]}>
      <Title>Este código es para el mostrador</Title>
      <Card>
        <Body>
          Este código es para mostrar en el mostrador de la veterinaria, no para escanear con tu
          propia cámara. Mostrá la pantalla del turno y dejá que ahí lo lean.
        </Body>
      </Card>
      <PrimaryButton label="Ir a mis turnos" onPress={() => router.replace(ROUTES.turnos)} />
    </Screen>
  );
}
