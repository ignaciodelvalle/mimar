// Crear consultorio — Libreta Nacional redesign.
// CrearConsultorioForm (client component) unchanged.

import { and, eq, inArray, isNull } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { LnCard, LnCardBody, LnCardHead } from "@/components/ui/Card";
import { db, organizationMemberships, organizations, profiles } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";

import { CrearConsultorioForm } from "./CrearConsultorioForm";

export default async function CrearConsultorioPage() {
  const { user } = await requireUserOrRedirect();

  const [profile] = await db
    .select({
      role: profiles.role,
      matriculaVerified: profiles.matriculaVerified,
      displayName: profiles.displayName,
    })
    .from(profiles)
    .where(eq(profiles.id, user.id))
    .limit(1);

  if (!profile) {
    redirect("/cuenta");
  }

  // Role gate with an explanation (task #17): this page used to hard-redirect a
  // non-vet to /cuenta silently, leaving no clue why the consultorio flow
  // vanished. Instead, tell the user what they need and point them at the path
  // to get it, so the guard reads as guidance rather than a dead-end bounce.
  if (profile.role !== "vet") {
    return (
      <RoleGateNotice
        title="Necesitás el rol de veterinario/a"
        body="Para crear un consultorio primero tenés que registrar tu matrícula profesional y que la autoridad de tu localidad la verifique."
        ctaHref="/cuenta/upgrade"
        ctaLabel="Registrar mi matrícula →"
      />
    );
  }

  if (!profile.matriculaVerified) {
    return (
      <RoleGateNotice
        title="Tu matrícula está en revisión"
        body="Ya figurás como veterinario/a, pero tu matrícula todavía no fue verificada. Cuando la autoridad la apruebe vas a poder crear tu consultorio."
        ctaHref="/cuenta/solicitudes"
        ctaLabel="Ver estado de mi solicitud →"
      />
    );
  }

  const [adminMembership] = await db
    .select({ publicToken: organizations.publicToken })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(
      and(
        eq(organizationMemberships.userId, user.id),
        inArray(organizationMemberships.role, ["admin", "coordinator"]),
        isNull(organizationMemberships.leftAt),
      ),
    )
    .limit(1);

  if (adminMembership) {
    redirect(`/org/${adminMembership.publicToken}`);
  }

  const defaultName = `Consultorio ${profile.displayName}`;

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
      <div className="mb-7">
        <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
          Crear consultorio
        </h1>
        <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
          Completá los datos de tu consultorio para empezar a ofrecer servicios en miMAR.
        </p>
      </div>

      <LnCard>
        <LnCardHead title="Datos del consultorio" />
        <LnCardBody>
          <CrearConsultorioForm defaultName={defaultName} />
        </LnCardBody>
      </LnCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RoleGateNotice — explains WHY the consultorio flow isn't available and points
// to the path that unblocks it, replacing the old silent redirect (task #17).
// ---------------------------------------------------------------------------

function RoleGateNotice({
  title,
  body,
  ctaHref,
  ctaLabel,
}: {
  title: string;
  body: string;
  ctaHref: string;
  ctaLabel: string;
}) {
  return (
    <div className="mx-auto max-w-2xl px-8 py-7 pb-12">
      <Link
        href="/cuenta"
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← Mi cuenta
      </Link>

      <LnCard>
        <LnCardHead title={title} />
        <LnCardBody>
          <p className="mb-4 text-md text-[var(--color-ln-ink-2)]">{body}</p>
          <Link
            href={ctaHref}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--color-ln-azul)] px-3.5 py-2 text-md font-semibold text-white no-underline transition-opacity hover:opacity-90"
          >
            {ctaLabel}
          </Link>
        </LnCardBody>
      </LnCard>
    </div>
  );
}
