// Captura rápida — Libreta Nacional redesign.
// Presentation only; CaptureBox client component unchanged.
//
// pet-document-redesign ADR-5: `?sheet=anotar` (SheetMounter) is now the
// PRIMARY in-profile entry point; this route survives as a thin fallback
// host page — same render, reachable via deep links (buildCaptureDeeplink),
// e2e, and the /eventos/nuevo redirect doctrine (AGENTS.md rule 5). The
// options list below is shared with the sheet via CaptureOptionsList.

import Link from "next/link";

import { isPetAdoptedByUser } from "@/lib/infra/adoption-checkin";
import { requireOwnedPetByToken } from "@/lib/infra/pets";
import { canStartPregnancy } from "@/src/modules/pets/application/pregnancy/pregnancy-eligibility";
import { CaptureBox } from "./CaptureBox";
import { CaptureOptionsList } from "./CaptureOptionsList";

export default async function CapturePage({
  params,
  searchParams,
}: {
  params: Promise<{ publicToken: string }>;
  searchParams: Promise<{ text?: string; kind?: string }>;
}) {
  const { publicToken } = await params;
  const { text, kind } = await searchParams;
  const session = await requireOwnedPetByToken(publicToken);
  const { pet, user } = session;

  const token = pet.publicToken;

  // QA A9: the "Check-in post-adopción" catalog entry only renders for the
  // registered adopter — the target page 404s for anyone else.
  const showCheckinOption = await isPetAdoptedByUser(pet.id, user.id);

  // The "Registrar embarazo" entry renders only for an animal that can open one
  // — the same predicate the destination page enforces, read off the `pets` row
  // this page already loaded. No extra query.
  const showPregnancyStartOption = canStartPregnancy(pet);

  return (
    <div className="mx-auto max-w-2xl px-8 py-7 pb-12">
      {/* Back */}
      <Link
        href={`/mis-mascotas/${token}`}
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← {pet.name}
      </Link>

      {/* Header */}
      <div className="mb-6">
        <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
          Anotar algo de {pet.name}
        </h1>
        <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
          Contanos qué pasó. Te llevamos al formulario correcto con los datos que pudimos
          identificar. Si preferís, abajo tenés atajos para los eventos más comunes.
        </p>
      </div>

      <CaptureBox
        petPublicToken={token}
        petName={pet.name}
        initialText={text}
        initialKind={kind}
        showCheckinOption={showCheckinOption}
      />

      {/* WP-7: Full discoverability list — all loggable events and owner flows,
          grouped by category, driven by ALL_CAPTURE_OPTIONS + registry so it
          stays in sync automatically. Shared with SheetMounter's ?sheet=anotar
          via CaptureOptionsList (pet-document-redesign D1). */}
      <div className="mt-10 space-y-7">
        <div className="flex items-center gap-3 text-xs text-[var(--color-ln-mute)]">
          <div className="flex-1 h-px bg-[var(--color-ln-stripe)]" />
          {/* Ver S2-F09 en CaptureBox: catálogo completo, no repetición. */}
          <span>Todos los tipos de registro</span>
          <div className="flex-1 h-px bg-[var(--color-ln-stripe)]" />
        </div>

        <CaptureOptionsList
          petPublicToken={token}
          showCheckinOption={showCheckinOption}
          showPregnancyStartOption={showPregnancyStartOption}
        />
      </div>
    </div>
  );
}
