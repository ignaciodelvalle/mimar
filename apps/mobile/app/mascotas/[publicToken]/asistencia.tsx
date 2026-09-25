// Perro de asistencia — la designación de Ley 26.858 (D3, 2026-09-25).
//
// A REAL ROUTE nested under the pet, for the reason `chapita`, `cuidado` and
// `vacunas` are: the stack header, the back gesture, and "back" landing on the
// animal somebody came from.
//
// A thin shell: validates the parameter and delegates. Who may manage the
// designation is the server's call (`canManageServiceDog`), never derived here.

import { useLocalSearchParams } from "expo-router";

import { useGate } from "../../../src/auth/useGate";
import { ServiceDogScreen } from "../../../src/pets/ServiceDogScreen";
import { ErrorNotice } from "../../../src/ui/components";
import { Screen } from "../../../src/ui/kit";

export default function AsistenciaRoute() {
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

  return <ServiceDogScreen publicToken={publicToken} />;
}
