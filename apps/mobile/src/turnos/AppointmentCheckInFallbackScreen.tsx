// The check-in QR's fallback — what a phone draws when it follows
// `mimar://appointment/{token}` (F-8, closing part of the debt
// `turnos-view-model.ts` and `DEEP_LINK_MAP.appointment` both declare).
//
// THIS SCREEN IS NOT THE READER. The QR on `/turnos/{appointmentToken}`
// encodes this exact link as a payload for a front-desk device that does not
// exist yet — see that screen's own header and `turnos-view-model.ts`'s. What
// THIS screen closes is a narrower, real gap: today a phone that follows the
// link anyway lands on `+not-found`, a page about routing. That is the wrong
// sentence for someone who scanned a QR they were shown, not a link somebody
// sent them.
//
// THE COPY DOES NOT GUESS WHO IS HOLDING THE PHONE, on purpose. Whoever this
// screen draws for could be the vet's own front desk (their phone or tablet
// resolved the scheme because it happens to have miMAR installed) or the
// owner, who tapped their own QR by mistake — and the same sentence must be
// honest for both: "this code is for the vet's counter", not "don't use your
// own camera", which assumes the reader IS the owner and reads oddly to
// someone at a front desk who was never told this was a camera problem.
//
// NO TOKEN, NO SESSION, NO LOOKUP, ON PURPOSE. The front desk scanning this on
// their own device is very likely NOT signed in as the pet's owner — may not
// be signed in at all — and the one thing this screen must never do is answer
// a question about WHOSE turno this is to whoever is holding the phone. It
// reads no state, calls no endpoint, and never renders the `appointmentToken`
// the route carries: a signed-in owner who taps their own QR by mistake gets
// the exact same generic sentence as anybody else. Branching on whether a
// session exists, or printing the token back, would make the screen's
// behaviour depend on who is holding it — exactly the kind of data-shaped
// signal a front-desk scan must not leak.
//
// "Ir a mis turnos" is offered anyway, because it is a safe, generic exit: it
// is gated on its own (`app/turnos/index.tsx` behind `useGate`), so someone
// signed out lands on ingreso like any other cold navigation there, and it
// tells this screen nothing about who tapped it.

import { useRouter } from "expo-router";

import { Body, Card } from "../ui/components";
import { PrimaryButton, Screen, Title } from "../ui/kit";
import { ROUTES } from "../ui/routes";

export function AppointmentCheckInFallbackScreen() {
  const router = useRouter();
  return (
    <Screen edges={["top", "bottom"]}>
      <Title>Este código es para la veterinaria</Title>
      <Card>
        <Body>
          Este código es para que lo escaneen en la veterinaria. Mostralo en el mostrador.
        </Body>
      </Card>
      <PrimaryButton label="Ir a mis turnos" onPress={() => router.replace(ROUTES.turnos)} />
    </Screen>
  );
}
