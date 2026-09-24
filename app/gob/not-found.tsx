import { BrandedNotFound } from "@/components/BrandedNotFound";

// Branded Spanish 404 for /gob/* (admin fresh-sweep A1, extends Fase 0 item 0.4).
export default function GobNotFound() {
  return (
    <BrandedNotFound
      title="No encontramos esta página"
      body="La página que buscás no existe o cambió de lugar. Revisá la dirección o volvé al panel."
      primary={{ href: "/gob", label: "Volver al panel" }}
    />
  );
}
