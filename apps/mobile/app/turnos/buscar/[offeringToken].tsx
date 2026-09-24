// `/turnos/buscar/{offeringToken}` — one service's horarios, and the reserva.
//
// ONE SCREEN FOR WHAT THE WEB SPLITS ACROSS TWO PAGES — the grid and the pet
// picker. The reasoning is in `ReservarTurnoScreen`'s own header; the short form
// is that this screen cannot honestly offer a time to somebody with no bookable
// animal, so it has to know about the animals before it draws the grid.
//
// AFTER A SUCCESSFUL BOOKING IT REPLACES ITSELF WITH THE TURNO. `router.replace`
// and not `push`: the grid this person came from is now stale by exactly the place
// they just took, and a back gesture onto it would offer them the slot they are
// holding. The web makes the same move for the same reason — `bookSlotAction`
// returns `redirectTo: /mis-turnos/{token}` rather than re-rendering the form.
//
// THE PARAMETER IS VALIDATED, not trusted. `useLocalSearchParams` is typed
// `string | string[]` because a path segment can legally repeat, and an empty
// value would ask the screen to read an offering named "" — which the server
// would honestly answer 404 to, a sentence about the wrong thing.

import { useLocalSearchParams, useRouter } from "expo-router";

import { useGate } from "../../../src/auth/useGate";
import { ReservarTurnoScreen } from "../../../src/turnos/ReservarTurnoScreen";
import { ErrorNotice } from "../../../src/ui/components";
import { Screen } from "../../../src/ui/kit";
import { turnoRoute } from "../../../src/ui/routes";

export default function ReservarTurnoRoute() {
  const gate = useGate();
  const router = useRouter();
  const params = useLocalSearchParams<{ offeringToken?: string | string[] }>();

  if (!gate.allowed) return gate.element;

  const raw = params.offeringToken;
  const offeringToken = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";

  if (offeringToken.length === 0) {
    return (
      <Screen>
        <ErrorNotice message="Este link no apunta a un servicio. Abrí Buscar turno y entrá desde ahí." />
      </Screen>
    );
  }

  return (
    <ReservarTurnoScreen
      offeringToken={offeringToken}
      onBooked={(appointmentToken) => router.replace(turnoRoute(appointmentToken))}
    />
  );
}
