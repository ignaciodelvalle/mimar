// `/casos` — the owner's casos: every open cycle plus the recent history (M11).
//
// The web keeps these in the `/mis-mascotas` bandeja; the app gives them a
// screen of their own because the Mis mascotas block shows only the open ones.
// A thin shell: it refuses to render without a session and hands off.

import { useRouter } from "expo-router";

import { useGate } from "../../src/auth/useGate";
import { CasesScreen } from "../../src/cases/CasesScreen";

export default function CasosRoute() {
  const gate = useGate();
  const router = useRouter();

  if (!gate.allowed) return gate.element;

  return (
    <CasesScreen
      // Each row's route is an IN-APP path the server resolved through the
      // deep-link table, or the row is drawn inert and never calls this.
      onOpenRoute={(route) => router.push(route as Parameters<typeof router.push>[0])}
    />
  );
}
