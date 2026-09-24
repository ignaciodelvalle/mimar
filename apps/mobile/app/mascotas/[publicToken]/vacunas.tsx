// Próximas vacunas — programar un recordatorio de vacuna, o eliminar uno.
//
// A REAL ROUTE, nested under the pet, for the reason `mudanza`, `editar` and
// `asentar` are: it earns the back gesture and the stack header, and nesting
// it under the animal is what makes "back" land on the pet somebody came from
// — the face's reminders card, which re-reads on focus and so shows the new
// state without a pull.
//
// The route is a thin shell: it validates the path parameter, refuses to render
// without a session, and hands off. Who may schedule or cancel is decided on
// the server (the web's own guard, every current holder) and arrives as a 403;
// this screen never derives it.

import { useLocalSearchParams } from "expo-router";

import { useGate } from "../../../src/auth/useGate";
import { VacunasScreen } from "../../../src/pets/VacunasScreen";
import { ErrorNotice } from "../../../src/ui/components";
import { Screen } from "../../../src/ui/kit";

export default function VacunasRoute() {
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

  return <VacunasScreen publicToken={publicToken} />;
}
