import Link from "next/link";

import { LnSheetCard, LnSheetWrap } from "@/components/ui/Sheet";
import { requireOwnedPetByToken } from "@/lib/infra/pets";
import { reportBiteAction } from "@/src/modules/surveillance/actions";

import { BiteForm } from "./BiteForm";

export default async function NewBitePage({
  params,
  searchParams,
}: {
  params: Promise<{ publicToken: string }>;
  searchParams: Promise<{ occurredAt?: string }>;
}) {
  const { publicToken } = await params;
  const sp = await searchParams;
  const { pet } = await requireOwnedPetByToken(publicToken);
  // Captura-rápida URL-prefill slots (event-capture-registry).
  const defaults = {
    occurredAt: sp.occurredAt ?? null,
  };

  const isInObservation = pet.rabiesObservationStatus === "in_progress";
  const boundAction = reportBiteAction.bind(null, publicToken);

  if (isInObservation) {
    return (
      <LnSheetWrap>
        <LnSheetCard>
          <div className="px-[18px] py-6 space-y-[10px]">
            <p className="font-ln-serif text-base font-semibold text-[var(--color-ln-warn)]">
              Ya hay una observación en curso
            </p>
            <p className="text-md text-[var(--color-ln-mute)]">
              {pet.name} está en observación antirrábica por otra mordedura. Esperá a que termine
              antes de reportar una nueva.
            </p>
            <Link
              href={`/mis-mascotas/${pet.publicToken}`}
              className="inline-block font-ln-mono text-sm text-[var(--color-ln-azul)] underline underline-offset-2"
            >
              Volver al perfil →
            </Link>
          </div>
        </LnSheetCard>
      </LnSheetWrap>
    );
  }

  return (
    <LnSheetWrap>
      <LnSheetCard>
        <BiteForm action={boundAction} petName={pet.name} defaults={defaults} />
      </LnSheetCard>
    </LnSheetWrap>
  );
}
