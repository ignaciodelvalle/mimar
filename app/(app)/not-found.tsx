import { BrandedNotFound } from "@/components/BrandedNotFound";

// Branded Spanish 404 for the (app) owner group (admin fresh-sweep A1, extends
// Fase 0 item 0.4).
export default function AppNotFound() {
  return (
    <BrandedNotFound
      title="No encontramos esta página"
      body="La página que buscás no existe o cambió de lugar. Revisá la dirección o volvé al inicio."
      primary={{ href: "/inicio", label: "Volver al inicio" }}
      secondary={{ href: "/mis-mascotas", label: "Mis mascotas" }}
    />
  );
}
