// La foto de la credencial, elegida y subida desde el teléfono.
//
// A REAL ROUTE, nested under the pet, for the reason editar and modo perdida
// are: it earns the back gesture and the stack header, and nesting it under
// the animal is what makes "back" land on the pet somebody came from.
//
// The route is a thin shell: it validates the path parameter, refuses to
// render without a session, and hands off. Whether this BUILD can pick a photo
// at all is the image-picker seam's answer, and `PetPhotoScreen` reads it —
// the route does not.

import { useLocalSearchParams } from "expo-router";

import { useGate } from "../../../src/auth/useGate";
import { PetPhotoScreen } from "../../../src/pets/PetPhotoScreen";
import { ErrorNotice } from "../../../src/ui/components";
import { Screen } from "../../../src/ui/kit";

export default function FotoRoute() {
  const gate = useGate();
  const params = useLocalSearchParams<{ publicToken?: string | string[] }>();

  if (!gate.allowed) return gate.element;

  const raw = params.publicToken;
  const publicToken = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";

  if (publicToken.length === 0) {
    return (
      <Screen>
        <ErrorNotice message="Este link no apunta a una mascota. Volvé a tu lista de mascotas y entrá desde ahí." />
      </Screen>
    );
  }

  return <PetPhotoScreen publicToken={publicToken} />;
}
