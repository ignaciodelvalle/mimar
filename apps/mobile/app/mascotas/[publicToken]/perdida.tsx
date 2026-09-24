// Modo perdida — the search for one animal.
//
// A REAL ROUTE, nested under the pet, for the same reason "Asentar" is one: it
// earns the back gesture, the stack header, and eventually an address. Nesting
// it under the pet is what makes "back" land on the animal somebody came from.
//
// The route is a thin shell: it validates the path parameter, refuses to render
// without a session, and hands off. Every rule about who may do what lives on
// the server and arrives as `capabilities`; `LostScreen` renders them and
// invents none.

import { useLocalSearchParams } from "expo-router";

import { useGate } from "../../../src/auth/useGate";
import { LostScreen } from "../../../src/lost/LostScreen";
import { ErrorNotice } from "../../../src/ui/components";
import { Screen } from "../../../src/ui/kit";

export default function PerdidaRoute() {
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

  return <LostScreen publicToken={publicToken} />;
}
