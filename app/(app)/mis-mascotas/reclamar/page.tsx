// Pet claim wizard — Libreta Nacional redesign.
// Presentation only; ClaimWizard client component unchanged.

import Link from "next/link";

import { LnCallout } from "@/components/ui/DocElements";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { ClaimWizard } from "./ClaimWizard";

export default async function ClaimPage() {
  // A4-custodia-08. The native app hands this page a finder who has just been
  // told the animal "ya tiene dueño/a" and tapped "Iniciar una disputa desde la
  // web": Chrome opens a login screen with no explanation, and after signing in
  // the bare `requireUserOrRedirect()` landed them on Mis mascotas — where they
  // had to find Reclamar again and retype the fifteen digits they had just
  // typed. The guard has taken a `returnTo` since it was written; this door was
  // simply not passing one.
  await requireUserOrRedirect("/mis-mascotas/reclamar");

  return (
    <div className="mx-auto max-w-md px-8 py-7 pb-12">
      {/* Back */}
      <Link
        href="/mis-mascotas"
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← Mis mascotas
      </Link>

      {/* Header */}
      <div className="mb-6">
        <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
          Reclamar una mascota
        </h1>
        <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
          Si tu mascota ya está registrada por su microchip o tatuaje, podés vincularla a tu cuenta
          — o iniciar una disputa si figura a nombre de otra persona.
        </p>
      </div>

      <ClaimWizard />

      <div className="mt-6">
        <LnCallout tone="azul" title="¿Te adoptó un refugio?">
          Si te registraron por DNI durante la adopción,{" "}
          <Link
            href="/mis-mascotas/reclamar-dni"
            className="text-[var(--color-ln-azul)] no-underline hover:underline"
          >
            reclamá por DNI acá →
          </Link>
        </LnCallout>
      </div>
    </div>
  );
}
