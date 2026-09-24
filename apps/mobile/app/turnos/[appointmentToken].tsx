// `/turnos/{appointmentToken}` — one turno, its check-in QR and its cancel.
//
// NOT A DEEP-LINK DESTINATION, and that is worth saying at the top because this
// screen renders the very QR that looks like one. `DEEP_LINK_MAP.appointment`
// carries `appPath: "appointment/:appointmentToken"` — a payload for a front-desk
// reader that does not exist yet, kept byte-for-byte, and the single member of
// `APP_PATH_NAMES_NO_SCREEN`. It does NOT resolve here and must not be pointed
// here by hand: changing that string changes the code the web already prints on
// every check-in QR. The debt is declared; closing it is the reader's work unit.
//
// THE PARAMETER IS VALIDATED, not trusted. `useLocalSearchParams` is typed
// `string | string[]` because a path segment can legally repeat, and an empty
// value would ask the screen to find a turno named "" — which it would honestly
// report as "not in your account", a sentence about the wrong thing.

import { useLocalSearchParams } from "expo-router";

import { useGate } from "../../src/auth/useGate";
import { TurnoDetailScreen } from "../../src/turnos/TurnoDetailScreen";
import { ErrorNotice } from "../../src/ui/components";
import { Screen } from "../../src/ui/kit";

export default function TurnoDetailRoute() {
  const gate = useGate();
  const params = useLocalSearchParams<{ appointmentToken?: string | string[] }>();

  if (!gate.allowed) return gate.element;

  const raw = params.appointmentToken;
  const appointmentToken = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";

  if (appointmentToken.length === 0) {
    return (
      <Screen>
        <ErrorNotice message="Este link no apunta a un turno. Abrí Mis turnos y entrá desde ahí." />
      </Screen>
    );
  }

  return <TurnoDetailScreen appointmentToken={appointmentToken} />;
}
