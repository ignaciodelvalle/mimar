// "Invitación enviada" — the screen a caretaker designation ends on.
//
// It was client state in DesignateCaretakerForm and nobody saw it: the action's
// revalidation re-rendered `/cuidado`, which swaps the form for the withdraw
// controls once an invitation is pending (see caretakerInviteSentPath). This
// route renders from the pending invitation in the database, so the refresh
// cannot take it away.
//
// Same gate as `/cuidado`: only the titular designates, so only the titular is
// told the invitation went out. Anything that is not a pending invitation —
// nothing sent, already accepted, withdrawn — goes back to `/cuidado`, which
// renders whichever of its three states is true.

import { notFound, redirect } from "next/navigation";

import { LnSuccessScreen } from "@/components/ui/SuccessScreen";
import { requireTitularAccess } from "@/lib/infra/pet-access";
import { getCaretakerStateForPet } from "@/src/modules/caretakers/application/get-caretaker-state-for-pet";
import { CaretakersRepository } from "@/src/modules/caretakers/infrastructure/caretakers-repository";

export default async function CaretakerInviteSentPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  const caretakerHref = `/mis-mascotas/${publicToken}/cuidado`;

  const access = await requireTitularAccess(publicToken);
  if (!access.ok) {
    if (access.reason === "no-session") {
      redirect(`/iniciar-sesion?returnTo=${encodeURIComponent(caretakerHref)}`);
    }
    if (access.reason === "not-titular") redirect(caretakerHref);
    notFound();
  }

  const { pet } = access;
  const now = new Date();
  const state = await getCaretakerStateForPet(pet.id, {
    repo: CaretakersRepository,
    now: () => now,
  });
  if (!state.pending || state.active) {
    redirect(caretakerHref);
  }

  return (
    <div className="mx-auto max-w-md px-8 py-7 pb-12" data-section="caretaker-invite-sent">
      <LnSuccessScreen
        title="Invitación enviada"
        description={`Le avisamos a ${state.pending.caretakerEmail}. Hasta que acepte no cambia nada: ${pet.name} sigue siendo solo tuya y podés retirar la invitación cuando quieras.`}
        next={[
          { label: `Volver a ${pet.name}`, href: `/mis-mascotas/${pet.publicToken}` },
          { label: "Ver mis mascotas", href: "/mis-mascotas", variant: "secondary" },
        ]}
      />
    </div>
  );
}
