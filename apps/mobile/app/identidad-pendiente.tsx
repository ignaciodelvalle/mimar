// `/identidad-pendiente` — the gate for `profilePending: true`.
//
// A THIN ROUTE over `IdentidadPendienteScreen`, for `crear-cuenta.tsx`'s
// reason: this app's jest suite is anchored at `<rootDir>/src`
// (jest.config.js says so, and says why), so a component that lives under
// `app/` cannot be render-tested.
//
// WHAT STAYS HERE: only `useGate` itself and its `!gate.allowed` element —
// generic to every gated screen, and already exercised wherever `useGate` is
// used. `profilePending` is READ here and PASSED DOWN, never re-derived or
// re-checked: see `IdentidadPendienteScreen` for the check that used to live
// inline in THIS file and caused a redirect-loop bug, fixed 2026-09-04 — a
// caller whose identity had just been completed kept landing back on this
// screen forever, because nothing here (or in the screen) ever asked whether
// the gate still applied. `return-to.ts` carried part of the same fix: signing
// out from this screen no longer round-trips `next=/identidad-pendiente`
// through sign-in.

import { useLocalSearchParams } from "expo-router";

import { IdentidadPendienteScreen } from "../src/auth/IdentidadPendienteScreen";
import { useGate } from "../src/auth/useGate";

export default function IdentidadPendienteRoute() {
  const gate = useGate({ allowPendingIdentity: true });
  // `next` IS READ HERE AND PASSED DOWN, exactly like `profilePending` and for
  // the same reason. The gate puts it on the redirect (A4-custodia-03,
  // `pendingIdentityHref`) so somebody who arrived from a deep link finishes
  // step 2 and lands on the link instead of on an empty pet list.
  const { next } = useLocalSearchParams<{ next?: string }>();

  if (!gate.allowed) return gate.element;

  return <IdentidadPendienteScreen next={next} profilePending={gate.user.profilePending} />;
}
