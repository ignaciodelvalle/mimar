// Asentar — writing one asiento into one pet's libreta.
//
// A REAL ROUTE, nested under the pet, for the same reason the asiento detail is
// one: it earns the back gesture, the stack header, and eventually an address.
// Nesting it under the pet is what makes "back" land on the libreta the person
// came from.
//
// The route is a thin shell: it validates the path parameter, refuses to render
// without a session, and hands off. Every rule about what may be written lives
// in `RecordEventScreen` and, before that, in the contract.
//
// TWO OPTIONAL QUERY PARAMETERS, and they travel together. `kind` pre-selects a
// form; `source` names the `medication_started` asiento a medication END refers
// to. They exist for exactly one caller — the "Terminar medicación" affordance
// on that asiento's own screen — because that is the only place a person already
// holds the identifier. Arriving with a `kind` this screen does not know is not
// a crash: the picker is what renders, which is where the person was going.

import { useLocalSearchParams } from "expo-router";

import { useGate } from "../../../src/auth/useGate";
import { RecordEventScreen } from "../../../src/pets/RecordEventScreen";
import { type WritableKind, isWritableKind } from "../../../src/pets/record-event-view-model";
import { ErrorNotice } from "../../../src/ui/components";
import { Screen } from "../../../src/ui/kit";

export default function AsentarRoute() {
  const gate = useGate();
  const params = useLocalSearchParams<{
    publicToken?: string | string[];
    kind?: string | string[];
    source?: string | string[];
  }>();

  if (!gate.allowed) return gate.element;

  const first = (raw: string | string[] | undefined) =>
    (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  const publicToken = first(params.publicToken);

  if (publicToken.length === 0) {
    return (
      <Screen>
        <ErrorNotice message="Este link no apunta a la libreta de una mascota. Volvé a tu lista de mascotas y entrá desde ahí." />
      </Screen>
    );
  }

  const rawKind = first(params.kind);
  const kind: WritableKind | null = isWritableKind(rawKind) ? rawKind : null;
  const source = first(params.source);

  return (
    <RecordEventScreen
      publicToken={publicToken}
      initialKind={kind}
      sourceEventId={source.length === 0 ? null : source}
    />
  );
}
