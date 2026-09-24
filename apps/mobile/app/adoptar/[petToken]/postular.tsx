// `/adoptar/{petToken}/postular` — the application form.
//
// NESTED UNDER THE FICHA rather than beside it, and the reason is the back
// gesture: somebody who abandons the form should land on the animal they were
// reading about, not on the catalogue they scrolled past. The web nests it the
// same way for the same reason.
//
// THE CONTACT CARD IS BUILT FROM THE SESSION, NOT FROM A SECOND READ. `MeV1`
// carries the display name every cold launch already fetched; the e-mail it
// deliberately does NOT carry, and that absence is the whole defence for what a
// stolen access token buys (`/api/v1/me`'s own docblock). So the card names the
// person and says the shelter will also see the account's e-mail, rather than
// this screen fetching one to print — which would widen a payload the platform
// narrowed on purpose.

import { useLocalSearchParams, useRouter } from "expo-router";

import { AdoptionApplyScreen } from "../../../src/adoption/AdoptionApplyScreen";
import { useGate } from "../../../src/auth/useGate";
import { ROUTES, adoptionDetailRoute } from "../../../src/ui/routes";

export default function PostularRoute() {
  const gate = useGate();
  const router = useRouter();
  const { petToken, petName } = useLocalSearchParams<{ petToken: string; petName?: string }>();

  if (!gate.allowed) return gate.element;

  return (
    <AdoptionApplyScreen
      petToken={petToken}
      petName={petName ?? null}
      // `MeV1User` IS A DISCRIMINATED UNION and the mid-signup arm carries no
      // name — a person between step 1 and step 2 of signup has an `auth.users`
      // row and no `profiles` one. `useGate` without `allowPendingIdentity`
      // already redirects them, so this arm is unreachable here; reading it as
      // `null` rather than asserting the other arm is what keeps that true if
      // the gate's options ever change.
      applicantName={gate.user.profilePending ? null : gate.user.displayName}
      // NOT FETCHED. See the header — `/api/v1/me` withholds the e-mail on
      // purpose, and a screen that went looking for one would undo that.
      applicantEmail={null}
      onSubmitted={() => router.replace(ROUTES.adoptarPostulaciones)}
      onBackToFicha={() => router.replace(adoptionDetailRoute(petToken))}
    />
  );
}
