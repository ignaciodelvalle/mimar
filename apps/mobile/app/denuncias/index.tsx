// `/denuncias` — Mis denuncias (M16): the denuncias this person filed under
// their account, and the status of each, as the web's `/denuncias/mias`.
// A thin shell: it refuses to render without a session and hands off.

import * as Linking from "expo-linking";
import { useRouter } from "expo-router";

import { useGate } from "../../src/auth/useGate";
import { API_BASE_URL } from "../../src/config/api";
import { MyReportsScreen } from "../../src/denuncias/MyReportsScreen";
import { ROUTES, myReportRoute } from "../../src/ui/routes";

/**
 * The web's "Buscar mi denuncia": the page that takes an anonymous denuncia's
 * code. `/denuncias/codigo` has no index of its own — only `/codigo/{code}` —
 * so the search page is the door. Same shared-origin derivation as the rest.
 */
const FIND_BY_CODE_URL = `${API_BASE_URL}/denuncias/buscar`;

export default function MisDenunciasRoute() {
  const gate = useGate();
  const router = useRouter();

  if (!gate.allowed) return gate.element;

  return (
    <MyReportsScreen
      onOpenReport={(referenceCode) => router.push(myReportRoute(referenceCode))}
      onNewReport={() => router.push(ROUTES.denunciar)}
      onFindByCode={() => void Linking.openURL(FIND_BY_CODE_URL).catch(() => {})}
    />
  );
}
