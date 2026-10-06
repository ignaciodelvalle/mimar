// "Activamos la búsqueda" — the screen a successful "Marcar como perdida" ends on.
//
// It used to be client state inside MarkLostWizard, and the owner never saw it:
// the action's revalidation re-rendered the page hosting the wizard, that page
// branches on the status the action had just changed, and the wizard was
// unmounted with its `submitted` flag. See `lostActivatedPath` for the
// mechanism. This route reads the case from the database instead, so a refresh,
// a reload or a slow network cannot take the confirmation away.
//
// Only an OPEN lost episode earns the screen. A pet that is not lost (already
// found, or a hand-typed URL) and a lost pet whose episode auto-closed (the
// stale state the profile's banner handles) go back to the profile: congratulating
// someone on a search that is not running would be a false receipt.

import { deepLinkUrl } from "@dim/contract/links";
import { redirect } from "next/navigation";

import { LnSuccessScreen } from "@/components/ui/SuccessScreen";
import { fetchLostEpisodeForPet } from "@/lib/infra/lost-mode";
import { requireOwnedPetByToken } from "@/lib/infra/pets";
import { resolveSiteUrl } from "@/lib/infra/site-url";
import { lostShareText } from "../lost-activation";

export default async function LostSearchActivatedPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  const { pet } = await requireOwnedPetByToken(publicToken);
  const profileHref = `/mis-mascotas/${pet.publicToken}`;

  if (pet.status !== "lost") {
    redirect(profileHref);
  }
  const episode = await fetchLostEpisodeForPet(pet.id);
  if (!episode) {
    redirect(profileHref);
  }

  // Absolute, from the one origin resolver: this is the link a lost-pet post
  // carries into WhatsApp, so it must resolve on a stranger's phone. It goes
  // through the deep-link table, the single place a route rename is made.
  const credentialUrl = deepLinkUrl(resolveSiteUrl(), "credential", {
    publicToken: pet.publicToken,
  });
  const shareText = lostShareText(pet.name, pet.sex);
  const shareUrl = `https://wa.me/?text=${encodeURIComponent(`${shareText} ${credentialUrl}`)}`;

  return (
    <div className="mx-auto max-w-md px-8 py-7 pb-12" data-section="lost-search-activated">
      <LnSuccessScreen
        title={`Activamos la búsqueda de ${pet.name}`}
        description="Su perfil público ya muestra el aviso con la información que elegiste compartir. Podés ajustar qué se ve (teléfono, ubicación, email) desde su perfil cuando quieras."
        next={[
          { label: "Compartir por WhatsApp", href: shareUrl },
          {
            label: "Imprimir cartel A4",
            href: `/mis-mascotas/${pet.publicToken}/cartel`,
            variant: "secondary",
          },
          { label: "Volver al perfil", href: profileHref, variant: "tertiary" },
        ]}
      />
    </div>
  );
}
