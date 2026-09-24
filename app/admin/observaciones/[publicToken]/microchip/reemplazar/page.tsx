import { db, pets } from "@/db";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { fetchActiveIdentifications } from "@/lib/infra/pet-identifiers";
import { and, eq, isNull } from "drizzle-orm";
import { notFound } from "next/navigation";

import { OpCallout, OpCard, OpCardBody, OpCardHead, OpCrumbs } from "@/components/ui/dashboard";

import { ReplaceMicrochipForm } from "./ReplaceMicrochipForm";
import { replaceMicrochipAdminAction } from "./action";

export default async function ReplaceMicrochipAdminPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  await requireAdminOrRedirect();

  // Art. 16 (Ley 25.326) — this door is addressed by a pet TOKEN and nothing
  // else: `requireAdminOrRedirect` proves the caller is a platform admin, but no
  // state record about THIS pet mediates the access. That is the same door
  // `loadOperatorPetSubView` (lib/infra/gob-pet-subview.ts) already filters for
  // /admin/mascotas/[token] — and unlike its sibling `loadGobPetSubView`, which
  // reaches a pet only THROUGH an in-jurisdiction welfare report or case and is
  // unfiltered on purpose, there is no nexus here to carve out for. Without the
  // term an admin holding an erased subject's token still read the pet's NAME
  // from the crumb and the heading, including on the "sin microchip" branch
  // below. The chip release the erasure performs made that branch the usual
  // outcome, which hid the leak behind a side effect instead of a guard.
  const [pet] = await db
    .select({ id: pets.id, name: pets.name, publicToken: pets.publicToken })
    .from(pets)
    .where(and(eq(pets.publicToken, publicToken), isNull(pets.deletedAt)))
    .limit(1);
  if (!pet) notFound();

  const boundAction = replaceMicrochipAdminAction.bind(null, pet.publicToken);
  const canonicalIds = await fetchActiveIdentifications(pet.id);

  if (!canonicalIds.microchip) {
    return (
      <div className="space-y-6">
        <OpCrumbs
          items={[
            { label: "Observaciones", href: "/admin/observaciones" },
            { label: pet.name, href: `/admin/observaciones/${pet.publicToken}` },
            { label: "Reemplazar microchip" },
          ]}
        />
        <header className="space-y-1">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
            {"Admin · Microchip"}
          </p>
          <h1 className="text-title font-semibold text-ln-op-ink">
            {"Reemplazar microchip — "}
            {pet.name}
          </h1>
        </header>
        <OpCallout
          title="Sin microchip registrado"
          body={`${pet.name} no tiene microchip registrado todavía.`}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <OpCrumbs
        items={[
          { label: "Observaciones", href: "/admin/observaciones" },
          { label: pet.name, href: `/admin/observaciones/${pet.publicToken}` },
          { label: "Reemplazar microchip" },
        ]}
      />

      <header className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
          {"Admin · Microchip"}
        </p>
        <h1 className="text-title font-semibold text-ln-op-ink">
          {"Reemplazar microchip — "}
          {pet.name}
        </h1>
        <p className="text-md text-ln-op-ink-2">
          {
            "Acción administrativa. Todas las razones están disponibles, incluidas fraude y duplicado. Quedará registrado en el log de auditoría."
          }
        </p>
      </header>

      <OpCard>
        <OpCardHead title="Datos del reemplazo" />
        <OpCardBody>
          <ReplaceMicrochipForm action={boundAction} currentChip={canonicalIds.microchip.code} />
        </OpCardBody>
      </OpCard>
    </div>
  );
}
