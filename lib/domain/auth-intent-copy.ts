// Intent-aware copy for the login/signup screens (Item 24.1).
//
// When a visitor is redirected to /login or /signup with an `intent` query
// parameter, the auth screen displays contextual copy explaining *why* they
// need an account — so the gate feels informative, not abrupt.
//
// The map is pure (no side effects) so it can be imported in both server
// components and tests without any env setup.

export type AuthIntent = "apply" | "foster" | (string & {});

export type IntentCopy = {
  /** Short headline that replaces the generic page title. */
  headline: string;
  /** One or two sentence subcopy that explains the gate. */
  subcopy: string;
};

/**
 * Returns intent-specific copy for the auth screen, or null if the intent
 * is unknown / absent (callers should fall back to default copy).
 */
export function getIntentCopy(intent: string | null | undefined): IntentCopy | null {
  if (!intent) return null;

  switch (intent) {
    case "apply":
      return {
        headline: "Postularte para adoptar",
        subcopy:
          "Necesitás una cuenta para enviar tu postulación, así el refugio puede contactarte.",
      };
    case "foster":
      return {
        headline: "Ofrecerte como tránsito",
        subcopy:
          "Necesitás una cuenta para registrarte como hogar de tránsito y que los refugios puedan encontrarte.",
      };
    default:
      // Generic returnTo-driven intent — explain the gate without assuming a
      // specific action (covers future intents before they get their own copy).
      return {
        headline: "Acceder a tu cuenta",
        subcopy: "Necesitás iniciar sesión para continuar con esa acción.",
      };
  }
}
