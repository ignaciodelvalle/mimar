// The WEB edge of `acceptLegalTermsForUser` — the re-acceptance screen at
// /aceptar-condiciones (2026-10-07). FormData in, the checkbox encoding turned
// into booleans, the use-case called with the GUARD's user id, a destination
// out. Lives in its own module (and its own barrel, app/actions/legal-acceptance.ts)
// for app/actions/sessions.ts's reason: it needs `requireLiveUser`, whose import
// chain must not leak into the signup barrel.

import { requireLiveUser } from "@/lib/infra/live-user";
import { safeReturnTo } from "@/lib/infra/role-landing";
import { acceptLegalTermsForUser } from "./accept-legal-terms";

export type LegalAcceptanceFormState = {
  error: string | null;
  /** Set on success: the full-page destination (contract N3 — never redirect()). */
  redirectTo?: string | null;
};

/**
 * @no-auth-required — the marker is about the SCANNER, not about the policy.
 * This function calls requireLiveUser in its own body and that call IS the
 * authorization; it is the first statement and it fails closed.
 */
export async function acceptLegalTermsAction(
  _previous: LegalAcceptanceFormState,
  formData: FormData,
): Promise<LegalAcceptanceFormState> {
  const live = await requireLiveUser();
  if (!live.ok) {
    return { error: "Tu sesión terminó. Volvé a iniciar sesión para continuar." };
  }

  const result = await acceptLegalTermsForUser({
    userId: live.user.id,
    email: live.user.email,
    tosAccepted: formData.get("tosAccepted") === "on",
    transferAccepted: formData.get("transferAccepted") === "on",
    adultDeclared: formData.get("adultDeclared") === "on",
    legalVersion: String(formData.get("legalVersion") ?? ""),
  });

  if (!result.ok) {
    switch (result.error) {
      case "NOT_ACCEPTED":
        return { error: "Para seguir tenés que marcar las tres casillas." };
      case "VERSION_MISMATCH":
        // The page was rendered by a previous deploy with an older text. A
        // reload shows the current one; recording either would be untrue.
        return { error: "Los textos cambiaron mientras tenías la página abierta. Recargala." };
      case "WRITE_FAILED":
        return { error: "No pudimos guardar tu aceptación. Probá de nuevo en un momento." };
      default: {
        const unhandled: never = result.error;
        throw new Error(`Unhandled legal acceptance refusal: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  const returnTo = safeReturnTo(String(formData.get("returnTo") ?? ""));
  return { error: null, redirectTo: returnTo ?? "/inicio" };
}
