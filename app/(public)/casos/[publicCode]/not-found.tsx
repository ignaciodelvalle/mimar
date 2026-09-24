import { BrandedNotFound } from "@/components/BrandedNotFound";

// Not-found for an unresolvable public case code.
//
// Same reasoning as denuncias/codigo/[code]/not-found.tsx: `notFound()` here
// fell through to the (public) group's shared screen, which answers "No
// encontramos esa credencial" and offers "Ver mascotas perdidas" — someone
// who typed a CAS-XXXX-XXXX code is looking for a case, and the app replied
// about pet credentials (9-role external run, 2026-08-18).
//
// Deliberately neutral about WHY the code didn't resolve: most case kinds are
// not public by design (canReadCasePublic), and this screen is reached both
// for codes that don't exist and codes that exist but aren't public. Saying
// which would make the route an existence oracle.
export default function CasoNotFound() {
  return (
    <BrandedNotFound
      title="No encontramos ese caso"
      body="Revisá que el código esté completo y bien tipeado — tiene la forma CAS-XXXX-XXXX. No todos los casos tienen página pública: si este código te lo dio un organismo o una organización, consultá el estado directamente con ellos."
      primary={{ href: "/", label: "Volver al inicio" }}
      secondary={{ href: "/ayuda", label: "Ir a Ayuda" }}
    />
  );
}
