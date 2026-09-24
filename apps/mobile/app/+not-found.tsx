// Where a link the app does not recognise lands.
//
// IT EXISTS BECAUSE LINKS NOW ARRIVE. Until `DEEP_LINK_MAP` had `appPath`
// values (WU-O) almost nothing could open this app from outside, so expo-router's
// default unmatched screen was a corner nobody reached. Now a notification, an
// invitation e-mail and a check-in QR can all hand this app a path, and one of
// them — `mimar://appointment/{token}`, the front-desk payload whose reader does
// not exist yet — resolves to no screen ON PURPOSE.
//
// The default screen is an English "Unmatched Route" with a developer's stack
// hint. That is the right answer for a developer and the wrong one for the
// person holding the phone: they followed a link somebody sent them and the app
// opened onto a page that talks about routing. This says what happened, in the
// app's own language, and offers the one thing that always works.
//
// IT DOES NOT GUESS. There is no "did you mean…" and no silent redirect to the
// pet list: an unknown link may be a link for a DIFFERENT account, and quietly
// landing somebody on their own animals would answer a question they did not
// ask.

// THE "VERSIÓN MÁS NUEVA" SENTENCE NOW HAS SOMEWHERE TO GO (critic gap 3).
// The copy below has always named the most likely cause of an unmatched link —
// the link belongs to a build newer than this one — and then left the person
// holding it with no way to act on that. Since the OTA hotfix of 2026-09-07
// there IS one: "Acerca de miMAR" in Ajustes carries a "Buscar actualización"
// button. Naming a cause without naming its remedy is the same defect as a
// disabled button with no reason (CA-M5), one screen over.

import { useRouter } from "expo-router";

import { Body, Card } from "../src/ui/components";
import { PrimaryButton, Screen, SecondaryButton, Title } from "../src/ui/kit";
import { ROUTES } from "../src/ui/routes";

export default function NotFoundRoute() {
  const router = useRouter();
  return (
    <Screen edges={["top", "bottom"]}>
      <Title>No pudimos abrir ese link</Title>
      <Card>
        <Body>
          El link que seguiste no corresponde a ninguna pantalla de esta app. Puede que sea de una
          versión más nueva, o que se haya copiado incompleto.
        </Body>
        <Body>
          Si puede ser una versión más nueva, buscá una actualización en Ajustes → Acerca de miMAR.
        </Body>
        {/* THE LABEL NAMES WHAT THE BUTTON DOES, AND DID NOT (finding L1,
            review 2026-09-07). It said "Buscar una actualización" and only
            navigated to Ajustes — a promise the next screen has to keep, in a
            string that is not even the real control's ("Buscar actualización",
            `UPDATE_CHECK_LABEL`). Two nearly-identical sentences, one of which
            is a lie about which one it is. */}
        <SecondaryButton label="Ir a Ajustes" onPress={() => router.push(ROUTES.ajustes)} />
        <Body>Si te lo mandaron por mail, probá abrirlo desde el navegador.</Body>
      </Card>
      <PrimaryButton label="Ir a mis mascotas" onPress={() => router.replace(ROUTES.misMascotas)} />
    </Screen>
  );
}
