// `/denuncias/{referenceCode}` — one of Mis denuncias (M16).
//
// A thin shell: it refuses to render without a session, validates the
// parameter and hands off. Whether this person may read the denuncia is
// decided by the server, never here — and an empty value would ask it for a
// denuncia named "", whose honest "no encontramos" would be about the wrong
// thing.

import { useLocalSearchParams, useRouter } from "expo-router";

import { useGate } from "../../src/auth/useGate";
import { MyReportDetailScreen } from "../../src/denuncias/MyReportDetailScreen";
import { ErrorNotice } from "../../src/ui/components";
import { Screen } from "../../src/ui/kit";

export default function MyReportDetailRoute() {
  const gate = useGate();
  const router = useRouter();
  const params = useLocalSearchParams<{ referenceCode?: string | string[] }>();

  if (!gate.allowed) return gate.element;

  const raw = params.referenceCode;
  const referenceCode = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";

  if (referenceCode.length === 0) {
    return (
      <Screen>
        <ErrorNotice message="Este link no apunta a una denuncia." />
      </Screen>
    );
  }

  return (
    <MyReportDetailScreen
      referenceCode={referenceCode}
      // Routes pushed from here are IN-APP paths the server resolved through
      // the deep-link table (the case the denuncia opened).
      onOpenRoute={(route) => router.push(route as Parameters<typeof router.push>[0])}
    />
  );
}
