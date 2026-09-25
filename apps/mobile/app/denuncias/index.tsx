// `/denuncias` — Mis denuncias (M16): the denuncias this person filed under
// their account, and the status of each, as the web's `/denuncias/mias`.
// A thin shell: it refuses to render without a session and hands off.

import { useRouter } from "expo-router";

import { useGate } from "../../src/auth/useGate";
import { MyReportsScreen } from "../../src/denuncias/MyReportsScreen";
import { ROUTES, myReportRoute } from "../../src/ui/routes";

export default function MisDenunciasRoute() {
  const gate = useGate();
  const router = useRouter();

  if (!gate.allowed) return gate.element;

  return (
    <MyReportsScreen
      onOpenReport={(referenceCode) => router.push(myReportRoute(referenceCode))}
      onNewReport={() => router.push(ROUTES.denunciar)}
    />
  );
}
