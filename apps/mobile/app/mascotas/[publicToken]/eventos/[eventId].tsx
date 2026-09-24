// One asiento of one pet's libreta.
//
// A REAL ROUTE and not a panel inside the libreta tab. A detail screen is a
// page: it earns the back gesture and the stack header, and nesting it under the
// pet is what makes "back" land on the libreta the reader came from rather than
// on the pet list. When the deep-link work lands (blocked on a Play-signed
// fingerprint, see app.config.ts), it also gives this screen an address.
//
// The route is a thin shell: it validates both path parameters, refuses to
// render without a session, and hands off. Every honesty rule lives in
// `EventDetailScreen`.
//
// THE PARAMETERS ARE VALIDATED, not trusted. `useLocalSearchParams` types each
// one `string | string[]` because a path segment can legally repeat, and a bad
// value here would become a request for `/events/undefined` — which the server
// answers 404, i.e. "no existe ese registro", a lie about the record rather than
// about the link. Better to say the link is broken.

import { useLocalSearchParams } from "expo-router";

import { useGate } from "../../../../src/auth/useGate";
import { EventDetailScreen } from "../../../../src/pets/EventDetailScreen";
import { ErrorNotice } from "../../../../src/ui/components";
import { Screen } from "../../../../src/ui/kit";

export default function LibretaEventRoute() {
  const gate = useGate();
  const params = useLocalSearchParams<{
    publicToken?: string | string[];
    eventId?: string | string[];
  }>();

  if (!gate.allowed) return gate.element;

  const first = (raw: string | string[] | undefined) =>
    (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  const publicToken = first(params.publicToken);
  const eventId = first(params.eventId);

  if (publicToken.length === 0 || eventId.length === 0) {
    return (
      <Screen>
        <ErrorNotice message="Este link no apunta a un registro de la libreta. Volvé a la libreta de tu mascota y entrá desde ahí." />
      </Screen>
    );
  }

  return <EventDetailScreen publicToken={publicToken} eventId={eventId} />;
}
