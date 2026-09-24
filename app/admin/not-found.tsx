import { BrandedNotFound } from "@/components/BrandedNotFound";

// Branded Spanish 404 for /admin/* — without this, an unknown admin URL falls
// to Next.js's black English default ("This page could not be found").
// Admin fresh-sweep A1 (extends Fase 0 item 0.4 to the admin group).
export default function AdminNotFound() {
  return (
    <BrandedNotFound
      title="No encontramos esta página"
      body="La página que buscás no existe o cambió de lugar. Revisá la dirección o volvé al panel."
      primary={{ href: "/admin", label: "Volver al panel" }}
    />
  );
}
