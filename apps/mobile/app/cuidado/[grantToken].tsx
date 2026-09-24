// `/cuidado/{grantToken}` — one caretaker invitation, and the answer to it.
//
// THE DEEP-LINK DESTINATION. `mimar://cuidado/CG-…` resolves here, and the path
// shape is deliberately the WEB's so the two forms of one destination cannot
// drift (`DEEP_LINK_MAP.caretakerGrant`).
//
// TOP-LEVEL, not under `/mascotas`, and the placement is the feature's rather
// than a filing preference: the person answering holds no `ownerships` row on the
// animal — that is what an invitation IS — so there is no pet of theirs to nest
// it under. It may well be the first animal they are ever responsible for.
//
// THE PARAMETER IS VALIDATED, not trusted. An empty value would ask the screen to
// find an invitation named "", which it would honestly report as "no está en tu
// cuenta" — a sentence about the wrong thing, and one that would read as a
// refusal rather than as a broken link.
//
// AFTER AN ACCEPT THE STACK IS REPLACED, not pushed onto. The person is the
// caretaker now, and `replace` is what stops the back gesture from returning to
// an invitation that no longer exists: the screen would re-read, find no OPEN row
// for a token it just answered, and say "no encontramos esta invitación" about
// something that just succeeded.

import { useLocalSearchParams, useRouter } from "expo-router";

import { useGate } from "../../src/auth/useGate";
import { CaretakerGrantScreen } from "../../src/caretakers/CaretakerGrantScreen";
import { ErrorNotice } from "../../src/ui/components";
import { Screen } from "../../src/ui/kit";
import { ROUTES, credentialRoute } from "../../src/ui/routes";

export default function CaretakerGrantRoute() {
  const gate = useGate();
  const router = useRouter();
  const params = useLocalSearchParams<{ grantToken?: string | string[] }>();

  if (!gate.allowed) return gate.element;

  const raw = params.grantToken;
  const grantToken = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";

  if (grantToken.length === 0) {
    return (
      <Screen>
        <ErrorNotice message="Este link no apunta a una invitación de cuidado. Pedile al titular que te la mande de nuevo." />
      </Screen>
    );
  }

  return (
    <CaretakerGrantScreen
      grantToken={grantToken}
      onAccepted={(petPublicToken) => {
        // `petPublicToken` can be null when the writer could not read it back
        // inside the transaction. The list is the honest fallback — and it is
        // where the animal now appears for this person, because accepting opened
        // an `ownerships` row for them.
        router.replace(
          petPublicToken === null ? ROUTES.misMascotas : credentialRoute(petPublicToken),
        );
      }}
    />
  );
}
