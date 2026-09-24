import { BrandedNotFound } from "@/components/BrandedNotFound";

// Branded, Spanish not-found for the (public) route group. Renders inside the
// citizen AppShell. Catches notFound() from any public page, most importantly
// the unknown/expired token branch of app/(public)/p/[publicToken]/page.tsx.
// UX audit remediation — Fase 0 item 0.4.
export default function PublicNotFound() {
  return (
    <BrandedNotFound
      title="No encontramos esa credencial"
      body="El código puede estar mal tipeado, o la credencial pudo haber expirado o haber sido dada de baja. Revisá el enlace o el QR e intentá de nuevo."
      primary={{ href: "/perdidas", label: "Ver mascotas perdidas" }}
      secondary={{ href: "/", label: "Volver al inicio" }}
    />
  );
}
