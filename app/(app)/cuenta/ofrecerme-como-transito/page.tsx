// Ofrecerme como hogar de tránsito — Libreta Nacional redesign.
// FosterVolunteerWizard (client component) unchanged.

import Link from "next/link";

import { Icon } from "@/components/Icon";
import { LnCallout } from "@/components/ui/DocElements";
import { db, fosterVolunteers, profiles } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { eq } from "drizzle-orm";

import { FosterVolunteerWizard } from "./FosterVolunteerWizard";

export default async function OfrecermeComoTransitoPage() {
  const { user } = await requireUserOrRedirect();

  const [profile] = await db
    .select({
      role: profiles.role,
      accountType: profiles.accountType,
      dniVerified: profiles.dniVerified,
      displayName: profiles.displayName,
      phone: profiles.phone,
    })
    .from(profiles)
    .where(eq(profiles.id, user.id))
    .limit(1);
  if (!profile) {
    return (
      <div className="mx-auto max-w-2xl px-8 py-7">
        <p className="text-md text-[var(--color-ln-err)]">No se encontró tu perfil.</p>
      </div>
    );
  }

  const checks = {
    isPersonalOwner: profile.role === "owner" && profile.accountType === "personal",
    dniVerified: profile.dniVerified,
    hasDisplayName: !!profile.displayName?.trim(),
    hasPhone: !!profile.phone?.trim(),
  };
  const ready = Object.values(checks).every(Boolean);

  const [existing] = ready
    ? await db.select().from(fosterVolunteers).where(eq(fosterVolunteers.userId, user.id)).limit(1)
    : [];

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
          Ofrecerme como hogar de tránsito
        </h1>
        <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
          Inscribite en el pool de voluntarios. Los refugios cerca tuyo te van a poder proponer
          tránsitos según tus preferencias.
        </p>
      </div>

      {!ready ? (
        <PreCheckChecklist checks={checks} />
      ) : (
        <FosterVolunteerWizard
          initial={
            existing
              ? {
                  status: existing.status as "active" | "paused" | "withdrawn",
                  availableSlots: existing.availableSlots,
                  jurisdictionProvince: existing.jurisdictionProvince,
                  jurisdictionLocality: existing.jurisdictionLocality,
                  acceptsDogs: existing.acceptsDogs,
                  acceptsCats: existing.acceptsCats,
                  acceptsOtherSpecies: existing.acceptsOtherSpecies,
                  acceptsSizeSmall: existing.acceptsSizeSmall,
                  acceptsSizeMedium: existing.acceptsSizeMedium,
                  acceptsSizeLarge: existing.acceptsSizeLarge,
                  acceptsPuppies: existing.acceptsPuppies,
                  acceptsSeniors: existing.acceptsSeniors,
                  acceptsChronicConditions: existing.acceptsChronicConditions,
                  acceptsDangerousBreeds: existing.acceptsDangerousBreeds,
                  maxDurationWeeks: existing.maxDurationWeeks,
                  householdOtherPets: existing.householdOtherPets,
                  householdKids: existing.householdKids,
                  notes: existing.notes,
                }
              : null
          }
        />
      )}
    </div>
  );
}

function PreCheckChecklist({
  checks,
}: {
  checks: {
    isPersonalOwner: boolean;
    dniVerified: boolean;
    hasDisplayName: boolean;
    hasPhone: boolean;
  };
}) {
  const items: { ok: boolean; label: string; cta: { href: string; text: string } | null }[] = [
    {
      ok: checks.isPersonalOwner,
      label: "Tu cuenta es personal con rol dueño",
      cta: checks.isPersonalOwner
        ? null
        : {
            href: "/cuenta",
            text: "Las cuentas institucionales no pueden ser voluntarios.",
          },
    },
    {
      ok: checks.dniVerified,
      label: "DNI declarado",
      cta: checks.dniVerified ? null : { href: "/cuenta/verificar-dni", text: "Declarar DNI" },
    },
    {
      ok: checks.hasDisplayName,
      label: "Nombre cargado",
      cta: checks.hasDisplayName
        ? null
        : { href: "/cuenta?sheet=editar-perfil", text: "Editar perfil" },
    },
    {
      ok: checks.hasPhone,
      label: "Teléfono cargado",
      cta: checks.hasPhone ? null : { href: "/cuenta?sheet=editar-perfil", text: "Editar perfil" },
    },
  ];

  return (
    <LnCallout tone="warn" title="Antes de inscribirte necesitamos lo siguiente:">
      <ul className="mt-2 flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.label} className="flex items-center gap-2">
            <span
              className={`inline-flex flex-shrink-0 items-center ${item.ok ? "text-[var(--color-ln-ok)]" : "text-[var(--color-ln-warn)]"}`}
            >
              <Icon name={item.ok ? "check" : "circle"} size={14} decorative />
            </span>
            <span className="flex-1 text-md text-[var(--color-ln-ink-2)]">{item.label}</span>
            {item.cta && (
              <Link
                href={item.cta.href}
                className="flex-shrink-0 text-sm text-[var(--color-ln-azul)] no-underline hover:underline"
              >
                {item.cta.text}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </LnCallout>
  );
}
