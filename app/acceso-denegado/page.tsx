import { BrandedNotFound } from "@/components/BrandedNotFound";

// A4: explained access-denied landing. A personal-role account (owner/vet) that
// navigates to an institutional portal (/gob, and its govt-only server actions)
// was previously bounced to /mis-mascotas with NO explanation — indistinguishable
// from a routing bug. The institutional guards now redirect here instead, so the
// user learns WHY they were moved and gets a clear way home.
//
// Reuses BrandedNotFound (the app-wide "you can't be here, here's the exit"
// pattern) so the screen matches every other branded stop page.

const PORTAL_LABELS: Record<string, string> = {
  gob: "de gobierno",
  admin: "de administración",
};

export default async function AccesoDenegadoPage({
  searchParams,
}: {
  searchParams: Promise<{ portal?: string }>;
}) {
  const { portal } = await searchParams;
  const portalLabel = portal ? PORTAL_LABELS[portal] : undefined;

  const title = portalLabel
    ? `No tenés acceso al portal ${portalLabel}`
    : "No tenés acceso a esta sección";

  const body = portalLabel
    ? `Tu cuenta no tiene permisos para el portal ${portalLabel}. Si creés que es un error, contactá a la administración.`
    : "Tu cuenta no tiene permisos para ver esta sección. Si creés que es un error, contactá a la administración.";

  return (
    <BrandedNotFound title={title} body={body} primary={{ href: "/", label: "Volver al inicio" }} />
  );
}
