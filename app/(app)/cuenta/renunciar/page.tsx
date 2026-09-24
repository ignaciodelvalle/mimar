// Renunciar a rol veterinario — Libreta Nacional redesign.
// VetSelfResignForm (client component) unchanged.

import { eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { LnCallout } from "@/components/ui/DocElements";
import { db, profiles } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";

import { VetSelfResignForm } from "./VetSelfResignForm";

export default async function RenunciarPage() {
  const { user } = await requireUserOrRedirect();

  const [profile] = await db
    .select({
      role: profiles.role,
      accountType: profiles.accountType,
      displayName: profiles.displayName,
    })
    .from(profiles)
    .where(eq(profiles.id, user.id))
    .limit(1);

  if (!profile || profile.role !== "vet" || profile.accountType !== "personal") {
    redirect("/cuenta");
  }

  return (
    <div className="mx-auto max-w-2xl px-8 py-7 pb-12">
      {/* Back */}
      <Link
        href="/cuenta"
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← Mi cuenta
      </Link>

      {/* Header */}
      <div className="mb-6">
        <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
          Renunciar a rol veterinario/a
        </h1>
        <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
          Hola, <strong>{profile.displayName}</strong>. Esta acción es irreversible desde este panel
          — para volver a tener el rol vet vas a tener que solicitarlo de nuevo.
        </p>
      </div>

      <LnCallout tone="warn" title="Esta acción es irreversible" className="mb-6">
        Al renunciar perdés acceso a las funciones veterinarias en miMAR.
      </LnCallout>

      <VetSelfResignForm />
    </div>
  );
}
