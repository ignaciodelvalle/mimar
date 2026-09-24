// `/mascotas/{publicToken}/cuidado` — the TITULAR'S side of cuidador temporal.
//
// NESTED UNDER THE PET because all three commands behind it are guarded against
// the ANIMAL (`requireTitularAccess`), so the pet is genuinely in the address —
// and because nesting is what makes the back gesture land on the animal somebody
// came from. Its sibling `/cuidado/{grantToken}` is top-level for the opposite
// reason: the person answering an invitation holds no ownership row at all.
//
// THE PARAMETER IS VALIDATED, not trusted. `useLocalSearchParams` is typed
// `string | string[]` because a path segment can legally repeat, and an empty
// value would ask the screen to look up an animal named "" — which it would
// honestly report as "no tenés un cuidado en curso", a sentence about the wrong
// thing. Better to say the link is broken.
//
// THE NAME TRAVELS AS A QUERY PARAM, optional, exactly as `transferir` does: the
// copy reads better with it and the screen has an honest fallback without it, so
// a deep link that carries only the token still works.

import { useLocalSearchParams } from "expo-router";

import { useGate } from "../../../src/auth/useGate";
import { CaretakerPetScreen } from "../../../src/caretakers/CaretakerPetScreen";
import { ErrorNotice } from "../../../src/ui/components";
import { Screen } from "../../../src/ui/kit";

export default function CaretakerPetRoute() {
  const gate = useGate();
  const params = useLocalSearchParams<{
    publicToken?: string | string[];
    name?: string | string[];
  }>();

  if (!gate.allowed) return gate.element;

  const rawToken = params.publicToken;
  const publicToken = (Array.isArray(rawToken) ? rawToken[0] : rawToken)?.trim() ?? "";
  const rawName = params.name;
  const petName = (Array.isArray(rawName) ? rawName[0] : rawName)?.trim() || null;

  if (publicToken.length === 0) {
    return (
      <Screen>
        <ErrorNotice message="Este link no apunta a una mascota. Abrí tus mascotas y entrá desde ahí." />
      </Screen>
    );
  }

  return <CaretakerPetScreen publicToken={publicToken} petName={petName} />;
}
