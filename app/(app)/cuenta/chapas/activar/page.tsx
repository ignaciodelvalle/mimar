// Activar chapa — owner self-activation page (physical-tag-lifecycle D8).
//
// Reached from the /t/[serial] neutral page CTA (?serial= prefilled) or from
// /cuenta/chapas. Requires a session (requireUserOrRedirect carries returnTo,
// so the anonymous QR scanner lands back here after login).
//
// NEVER gated by the engraved_plate jurisdiction rule (design D6): a shipped
// tag must always be activatable, even if the distribution channel was later
// disabled for the user's zone.

import { db, ownerships, pets } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { and, eq, isNull } from "drizzle-orm";

import { ActivateTagForm } from "./ActivateTagForm";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ serial?: string }>;
}

export default async function ActivarChapaPage({ searchParams }: PageProps) {
  const { serial } = await searchParams;
  const returnTo = serial
    ? `/cuenta/chapas/activar?serial=${encodeURIComponent(serial)}`
    : "/cuenta/chapas/activar";
  const { user } = await requireUserOrRedirect(returnTo);

  // Owned-pet selector: pets the user holds an active ownership on.
  const ownedPets = await db
    .select({ id: pets.id, name: pets.name })
    .from(ownerships)
    .innerJoin(pets, eq(pets.id, ownerships.petId))
    .where(
      and(eq(ownerships.ownerUserId, user.id), isNull(ownerships.endedAt), isNull(pets.deletedAt)),
    )
    .orderBy(pets.name);

  return (
    <div className="mx-auto max-w-xl px-8 py-7 pb-12">
      <div className="mb-7">
        <h1 className="m-0 font-ln-serif text-4xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
          Activar chapa
        </h1>
        <p className="mt-1.5 text-md text-[var(--color-ln-mute)]">
          Ingresá el número de serie de la chapa y el código impreso en el envoltorio.
        </p>
      </div>

      <ActivateTagForm
        initialSerial={serial ?? ""}
        pets={ownedPets.map((p) => ({ id: p.id, name: p.name }))}
      />
    </div>
  );
}
