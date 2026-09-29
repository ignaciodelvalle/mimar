// `/p/{publicToken}` — the verified Android App Link landing (native-review
// S-8, 2026-09-29). See `apps/mobile/app.config.ts`'s "ANDROID APP LINKS"
// section for the intent filter this route answers, what it is scoped to
// (`/p` only, never `/t` or its two sub-paths), and why.
//
// NO GATE, DELIBERATELY — the one thing that makes this route different from
// `app/mascotas/[publicToken]/credencial.tsx`, which renders the exact same
// `CredentialScreen` behind `useDisplayOnlyGate`. That gate exists for the
// OWNER's own device reading its cached copy offline; the audience an App Link
// exists for is the opposite case — a stranger who found the animal, has the
// app installed for some unrelated reason (or will after this ships), and has
// never signed in. `fetchCredential` (`src/credential/credential-api.ts`)
// already calls `GET /api/v1/pets/{token}/credential` with no bearer — it is
// the same anonymous document the web serves at this exact path — so putting a
// session gate in front of it here would answer a QR scan with a sign-in
// screen for a link nobody asked to log into, which is worse than the browser
// fallback this route replaces.
//
// THE PARAMETER IS VALIDATED, not trusted, same as every other dynamic route in
// this app: an empty value would ask the server for a credential named "", and
// the honest "no encontramos esta credencial" the server would answer is then a
// sentence about the wrong thing.

import { useLocalSearchParams } from "expo-router";

import { CredentialScreen } from "../../src/credential/CredentialScreen";
import { ErrorNotice } from "../../src/ui/components";
import { Screen } from "../../src/ui/kit";

export default function PublicCredentialLinkRoute() {
  const params = useLocalSearchParams<{ publicToken?: string | string[] }>();
  const raw = params.publicToken;
  const publicToken = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";

  if (publicToken.length === 0) {
    return (
      <Screen>
        <ErrorNotice message="Este link no tiene un código de credencial." />
      </Screen>
    );
  }

  return <CredentialScreen publicToken={publicToken} />;
}
