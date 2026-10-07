// "Encontré un animal" — for an animal with NO tag and NO QR, the most common
// case (P4; design note docs/superpowers/specs/2026-10-p4-receptoras-cercanas.md
// §5). Reached from the landing's "Encontré una mascota" door and from
// /perdidas.
//
// ORDER IS THE POLICY (PO 2026-10-07): reuniting with the family comes first.
//   1. check for a microchip — any vet reads it for free — and the nearest vets;
//   2. look for its family on /perdidas, filtered to the place;
//   3. only then, the organizations nearby that receive found animals.
//
// The place is a catalogue LOCALITY the finder picks (W8, PO 2026-09-24: the
// product never reads the device's location). It goes to the server in the
// body of a server action, never in this page's URL, and is not stored.
//
// @no-auth-required: public guidance page; the only data it shows is the
// public-safe projection of organizations that chose to be listed.

import type { Metadata } from "next";

import { FoundAnimalGuide } from "./FoundAnimalGuide";

// Under a per-request CSP nonce a prerendered page arrives dead
// (scripts/check-csp-prerender.ts), and the (public) layout is auth-aware.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Encontré un animal",
  description:
    "Encontraste un perro o un gato sin chapita ni QR: cómo saber si tiene chip, buscar a su familia y, si no podés tenerlo, qué organizaciones cercanas reciben animales encontrados.",
  alternates: { canonical: "/encontre-un-animal" },
};

export default function EncontreUnAnimalPage() {
  return (
    <main className="bg-[var(--color-ln-paper)]">
      <div className="mx-auto max-w-2xl space-y-6 px-4 py-10 sm:px-6">
        <header className="space-y-2">
          <h1 className="m-0 font-ln-serif text-4xl font-semibold leading-[1.1] tracking-[-0.02em] text-[var(--color-ln-ink)]">
            Encontré un animal
          </h1>
          <p className="text-base leading-[1.55] text-[var(--color-ln-ink-2)]">
            Gracias por frenar. Lo más probable es que su familia lo esté buscando: estos tres pasos
            ayudan a que vuelva a casa.
          </p>
          <p className="text-sm text-[var(--color-ln-mute)]">
            ¿Tiene chapita o QR? Escanealo con la cámara del celular: te lleva a su credencial y
            desde ahí le avisás a su familia.
          </p>
        </header>

        <FoundAnimalGuide />
      </div>
    </main>
  );
}
