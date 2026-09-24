// The in-app route to account deletion — the one Google Play will not ship the
// app without.
//
// IT IS NO LONGER A LINK TO A BROWSER (WU-R, 2026-08-29)
// ---------------------------------------------------------------------------
// This card used to open `ACCOUNT_DELETION_URL` and its docblock spent four
// paragraphs explaining the two costs of that: the person re-authenticates in a
// signed-out tab, and this app cannot know the deletion happened, so the card
// had to ASK them to close the session here afterwards. Both are paid off.
// `POST /api/v1/me/privacy` is a bearer call, and its 200 is what drops the
// session — see `eraseAccount` in the session store.
//
// So this is now a signpost and not a door out of the app: it says what the
// supresión is, and it navigates to the screen where the mandatory reason and
// the destructive confirmation live.
//
// WHY IT IS STILL A COMPONENT AND NOT SIX LINES INSIDE `app/ajustes.tsx`
// ---------------------------------------------------------------------------
// jest's `roots` is `<rootDir>/src` (jest.config.js, and the comment there
// explains why the glob cannot be widened safely on Windows), so nothing under
// `app/` is reachable by a test. Leaving this inline would have made the ONE
// screen element a store policy depends on the only element in the app with no
// test at all — and its failure mode is silent: a refactor drops the card, the
// build still compiles, and the next thing that notices is a Play review
// rejection weeks later. Every other real screen in this app already lives in
// `src/` for the same reason (CrearCuentaScreen, LostScreen, LibretaScreen).
//
// WHY THE BUTTON IS SECONDARY AND NOT `tone="seal"` — UNCHANGED, AND NOW WITH A
// SECOND REASON
// ---------------------------------------------------------------------------
// `seal` is this design's destructive tone, and pressing THIS button destroys
// nothing — it opens a screen. A red button that only navigates teaches people
// that red means "maybe", which is exactly the lesson that gets somebody to tap
// the real one. That real one is on `PrivacyScreen`, behind a disclosure step
// and a motivo of at least five characters, and it IS `seal`.
//
// The second reason is new: the screen this opens is not only the deletion. It
// is also the art. 14 export, which is not destructive at all, and painting its
// entrance red would misdescribe half of what is behind it.

import { useRouter } from "expo-router";

import { StyleSheet, View } from "react-native";
import { Body, Card } from "../ui/components";
import { SecondaryButton } from "../ui/kit";
import { ROUTES } from "../ui/routes";
import { SPACE } from "../ui/theme";

export function AccountDeletionCard() {
  const router = useRouter();

  return (
    <Card title="Privacidad y datos personales">
      <Body>
        Podés descargar todo lo que guardamos sobre vos (Ley 25.326, art. 14) y dar de baja tu
        cuenta pidiendo la supresión de tus datos personales (art. 16).
      </Body>
      <Body>
        Al darte de baja, tus datos de contacto se anonimizan; los eventos sanitarios de tus
        mascotas se conservan como historial de salud del animal.
      </Body>
      <View style={styles.actions}>
        {/* `push` and not `replace`: somebody who opens this to read what
            happens to their pets' records and changes their mind must land back
            on ajustes with the back gesture, not on the pet list. */}
        <SecondaryButton
          label="Ver mis datos o eliminar mi cuenta"
          onPress={() => router.push(ROUTES.privacidad)}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  actions: { gap: SPACE.sm, marginTop: SPACE.xs },
});
