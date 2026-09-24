// Devolución — responder a quien quiere devolverte el animal, o proponer
// devolvérselo a la organización de origen.
//
// A REAL ROUTE, nested under the pet, for the reason `editar`, `perdida` and
// `mudanza` are: it earns the back gesture and the stack header, and nesting it
// under the animal is what makes "back" land on the pet somebody came from.
//
// The route is a thin shell: it validates the path parameter, refuses to render
// without a session, and hands off. WHAT MAY BE DONE is entirely the server's —
// it arrives as `capabilities` on the read — and this screen invents none of it.

import { useLocalSearchParams } from "expo-router";

import { useGate } from "../../../src/auth/useGate";
import { DevolucionScreen } from "../../../src/custody/DevolucionScreen";
import { ErrorNotice } from "../../../src/ui/components";
import { Screen } from "../../../src/ui/kit";

export default function DevolucionRoute() {
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

  return <DevolucionScreen publicToken={publicToken} />;
}
