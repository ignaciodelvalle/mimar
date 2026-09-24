// Acompañamiento de adopción — pedir, cancelar el pedido, dar de baja.
//
// A REAL ROUTE, nested under the pet, for the reason `cuidado`, `mudanza` and
// `devolucion` are: it earns the back gesture and the stack header, and
// nesting it under the animal is what makes "back" land on the pet somebody
// came from — the face, which re-reads on focus and so shows the new banner
// without a pull.
//
// The route is a thin shell: it validates the path parameter, refuses to render
// without a session, and hands off. Who may do what is decided on the server
// (the legal owner alone — spec REQ-14) and arrives as `capabilities`; this
// screen never derives it.

import { useLocalSearchParams } from "expo-router";

import { useGate } from "../../../src/auth/useGate";
import { RehomeScreen } from "../../../src/pets/RehomeScreen";
import { ErrorNotice } from "../../../src/ui/components";
import { Screen } from "../../../src/ui/kit";

export default function BuscarHogarRoute() {
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

  return <RehomeScreen publicToken={publicToken} />;
}
