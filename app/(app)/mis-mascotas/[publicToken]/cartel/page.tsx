// /mis-mascotas/[publicToken]/cartel — printable lost-pet poster (A4).
//
// Gate: requirePetAccess. If pet.status !== 'lost', renders a "mark as lost first"
// message instead of the poster.

import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePetAccess } from "@/lib/infra/pet-access";
import {
  lostThirdPersonPhrase,
  markLostActionLabel,
  markLostFirstPrompt,
} from "@/lib/utils/format";
import { loadLostPoster } from "@/src/modules/lost/infrastructure/lost-poster-read";

import "./cartel-print.css";
import { PosterPreview } from "./PosterPreview";

export default async function CartelPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;

  const access = await requirePetAccess(publicToken);
  if (!access.ok) notFound();
  const { pet } = access;

  // Guard: poster only makes sense when the pet is marked lost.
  if (pet.status !== "lost") {
    return (
      <div className="mx-auto max-w-md px-8 py-12 text-center">
        <p className="font-ln-serif text-xl font-semibold text-[var(--color-ln-ink)]">
          {pet.name} no {lostThirdPersonPhrase(pet.sex)}.
        </p>
        <p className="mt-1.5 text-md text-[var(--color-ln-mute)]">{markLostFirstPrompt(pet.sex)}</p>
        <Link
          href={`/mis-mascotas/${publicToken}?sheet=marcar-perdida`}
          className="mt-5 inline-flex items-center rounded-[var(--radius-sm)] border border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-050)] px-4 py-[9px] font-ln-sans text-md font-medium text-[var(--color-ln-warn)] no-underline hover:opacity-80 transition-opacity"
        >
          {markLostActionLabel(pet.sex)}
        </Link>
      </div>
    );
  }

  // Everything the poster says, already filtered by the disclosure prefs —
  // the SAME resolver the native app's poster endpoint uses (M13).
  const poster = await loadLostPoster(pet, publicToken);

  return (
    <div className="min-h-screen bg-[var(--color-ln-stripe)] print:bg-white">
      <PosterPreview {...poster} />
    </div>
  );
}
