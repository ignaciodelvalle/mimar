// The gate route. It renders nothing of its own — it decides where a cold start
// lands and gets out of the way.
//
// Everything interesting is in `useGate`, which is the same decision every other
// screen makes. Here the "allowed" answer is itself a redirect: `/` is not a
// destination in this app, it is the question "who is holding this phone".

import { Redirect } from "expo-router";

import { useGate } from "../src/auth/useGate";
import { ROUTES } from "../src/ui/routes";

export default function Gate() {
  const gate = useGate();
  if (!gate.allowed) return gate.element;
  return <Redirect href={ROUTES.misMascotas} />;
}
