// Editar los datos de la mascota, y sus contactos de emergencia.
//
// A REAL ROUTE, nested under the pet, for the reason modo perdida and compartir
// are: it earns the back gesture and the stack header, and nesting it under the
// animal is what makes "back" land on the pet somebody came from.
//
// The route is a thin shell: it validates the path parameter, refuses to render
// without a session, and hands off. Every rule about who may edit what lives on
// the server and arrives as `capabilities`; `PetProfileEditScreen` renders them
// and invents none.

import { useLocalSearchParams } from "expo-router";

import { useGate } from "../../../src/auth/useGate";
import { PetProfileEditScreen } from "../../../src/pets/PetProfileEditScreen";
import { ErrorNotice } from "../../../src/ui/components";
import { Screen } from "../../../src/ui/kit";

export default function EditarRoute() {
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

  return <PetProfileEditScreen publicToken={publicToken} />;
}
