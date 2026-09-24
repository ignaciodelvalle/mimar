// `/casos/{publicCode}` — one case (M11).
//
// THE WEB'S PATH, kept identical on purpose: a notification's `cta_url` names
// `/casos/CAS-…`, and a path that differs only in scheme cannot drift from it.
// The route is a thin shell — it refuses to render without a session, validates
// the parameter and hands off. Whether this person may read the case is decided
// by the server, never here.
//
// THE PARAMETER IS VALIDATED, not trusted: an empty value would ask the server
// for a case named "", and the honest "no encontramos este caso" would then be
// a sentence about the wrong thing.

import { useLocalSearchParams, useRouter } from "expo-router";

import { useGate } from "../../src/auth/useGate";
import { CaseDetailScreen } from "../../src/cases/CaseDetailScreen";
import { ErrorNotice } from "../../src/ui/components";
import { Screen } from "../../src/ui/kit";

export default function CaseDetailRoute() {
  const gate = useGate();
  const router = useRouter();
  const params = useLocalSearchParams<{ publicCode?: string | string[] }>();

  if (!gate.allowed) return gate.element;

  const raw = params.publicCode;
  const publicCode = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";

  if (publicCode.length === 0) {
    return (
      <Screen>
        <ErrorNotice message="Este link no apunta a un caso." />
      </Screen>
    );
  }

  return (
    <CaseDetailScreen
      publicCode={publicCode}
      // Routes pushed from here are IN-APP paths the server resolved through
      // the deep-link table (the pet a case is about).
      onOpenRoute={(route) => router.push(route as Parameters<typeof router.push>[0])}
    />
  );
}
