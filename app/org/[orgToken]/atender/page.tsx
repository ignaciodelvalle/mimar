// Atender mascota — walk-in clinical signing ENTRY (#43, B1).
//
// A matriculated vet (or any org member with event.write) enters the DIM code
// printed on the physical credential the owner shows. On resolve, they are
// taken to the non-custody clinical signing surface. This closes the UX gate:
// the vet-home card previously linked to /mascotas (the custody list, EMPTY
// for a clinic) — a matriculated vet had no working entry to sign.

import Link from "next/link";
import { redirect } from "next/navigation";

import { OpCallout, OpCard, OpCardBody, OpCardHead, OpCrumbs } from "@/components/ui/dashboard";

import { CodeEntryForm } from "./CodeEntryForm";
import { lookupAtenderPetAction } from "./actions";
import { resolveAtenderContext } from "./atender-access";

export default async function AtenderEntryPage({
  params,
}: {
  params: Promise<{ orgToken: string }>;
}) {
  const { orgToken } = await params;
  const context = await resolveAtenderContext(orgToken);

  // A SHIFT THAT RAN OUT IS A SIGN-OUT, NOT A MESSAGE (B9).
  //
  // Rendering "tu turno terminó" in a card would leave the operator still
  // authenticated on the clinic's shared desk, which is the exact state the
  // control exists to prevent. Only /turno-vencido can end it — cookies are not
  // writable during a Server Component render — and it re-derives the policy
  // itself before signing anyone out, so this is the same branch every other
  // page guard takes (lib/infra/auth-guards.ts).
  //
  // Only this refusal navigates. The rest stay in place: they are conditions
  // the operator can read and act on without losing the surface.
  if (!context.ok && context.reason === "SHIFT_EXPIRED") redirect("/turno-vencido");

  const boundLookup = lookupAtenderPetAction.bind(null, orgToken);

  return (
    <main className="min-h-screen bg-ln-op-page p-6">
      <div className="max-w-lg mx-auto space-y-6">
        <header className="space-y-1">
          <OpCrumbs
            items={[{ label: "Inicio", href: `/org/${orgToken}` }, { label: "Atender mascota" }]}
          />
          <h1 className="text-title font-semibold text-ln-op-ink">Atender mascota</h1>
          <p className="text-md text-ln-op-ink-2">
            Registrá un evento clínico sobre la mascota que trae el dueño, sin necesidad de tenerla
            en custodia.
          </p>
        </header>

        {context.ok ? (
          <OpCard>
            <OpCardHead title="Credencial de la mascota" />
            <OpCardBody>
              <CodeEntryForm action={boundLookup} />
            </OpCardBody>
          </OpCard>
        ) : (
          <OpCard>
            <OpCardBody>
              <OpCallout title="Permiso requerido" body={context.error} />
              <div className="mt-4">
                <Link
                  href={`/org/${orgToken}`}
                  className="text-sm text-ln-op-mute underline hover:text-ln-op-ink"
                >
                  ← Volver al inicio
                </Link>
              </div>
            </OpCardBody>
          </OpCard>
        )}
      </div>
    </main>
  );
}
