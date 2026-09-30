// Viaje — the owner's trips, the semáforo, and the trip and CVI forms
// (viajes-fase-2, task 6.1).
//
// A REAL ROUTE, nested under the pet, for the reason `mudanza` and `vacunas`
// are: it earns the back gesture and the stack header, and "back" lands on the
// pet somebody came from.
//
// The route is a thin shell: it validates the path parameter, refuses to render
// without a session, and hands off. Who may plan a trip is decided on the
// server (`canAccessTravel`: owner, co-owner, foster) and arrives as a 403; the
// face only decides whether to OFFER the row.

import { useLocalSearchParams } from "expo-router";

import { useGate } from "../../../src/auth/useGate";
import { TravelScreen } from "../../../src/travel/TravelScreen";
import { ErrorNotice } from "../../../src/ui/components";
import { Screen } from "../../../src/ui/kit";

export default function ViajeRoute() {
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

  return <TravelScreen publicToken={publicToken} />;
}
