// `/aceptar-condiciones` — the gate for `legalAcceptancePending: true`
// (2026-10-07). A THIN ROUTE over `AceptarCondicionesScreen`, for
// `identidad-pendiente.tsx`'s reason: jest is anchored at `<rootDir>/src`, so a
// component under `app/` cannot be render-tested. The flag is READ here and
// PASSED DOWN; the screen owns the redirect once nothing is owed.

import { useLocalSearchParams } from "expo-router";

import { AceptarCondicionesScreen } from "../src/auth/AceptarCondicionesScreen";
import { useGate } from "../src/auth/useGate";

export default function AceptarCondicionesRoute() {
  const gate = useGate({ allowPendingLegal: true });
  const { next } = useLocalSearchParams<{ next?: string }>();

  if (!gate.allowed) return gate.element;

  const pending = !gate.user.profilePending && gate.user.legalAcceptancePending === true;
  return <AceptarCondicionesScreen next={next} legalAcceptancePending={pending} />;
}
