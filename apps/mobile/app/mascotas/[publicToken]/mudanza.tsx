// Registrar una mudanza — el animal cambió de jurisdicción.
//
// A REAL ROUTE, nested under the pet, for the reason `editar`, `perdida` and
// `compartir` are: it earns the back gesture and the stack header, and nesting
// it under the animal is what makes "back" land on the pet somebody came from —
// which here is `/editar`, where the entry point lives, exactly as on the web.
//
// The route is a thin shell: it validates the path parameter, refuses to render
// without a session, and hands off. Who may move an animal is decided on the
// server (`requireTitularAccess`'s rule) and arrives as a 403; this screen never
// derives it.

import { useLocalSearchParams } from "expo-router";

import { useGate } from "../../../src/auth/useGate";
import { MudanzaScreen } from "../../../src/custody/MudanzaScreen";
import { ErrorNotice } from "../../../src/ui/components";
import { Screen } from "../../../src/ui/kit";

export default function MudanzaRoute() {
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

  return <MudanzaScreen publicToken={publicToken} />;
}
