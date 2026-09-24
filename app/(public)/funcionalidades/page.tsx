import type { Metadata } from "next";
import Link from "next/link";

import { LnBadge, type LnBadgeProps } from "@/components/ui/Badge";

export const metadata: Metadata = {
  title: "Qué hace miMAR — Funcionalidades",
  description:
    "Mapa honesto de todo lo que hace miMAR: lo nacional funciona desde el día uno; lo local se enciende cuando tu localidad y sus organizaciones se suman.",
};

// Honest functionality map (PO redesign 2026-07-04). Three tiers by what has to
// be true for each feature to work: nothing (national), your locality opting in,
// or an organization nearby. One plain, law-citation-free line per row.

type FeatureRow = { name: string; line: string };

type FeatureTier = {
  id: string;
  title: string;
  badgeLabel: string;
  badgeVariant: LnBadgeProps["variant"];
  rows: FeatureRow[];
};

const TIERS: FeatureTier[] = [
  {
    id: "nacional",
    title: "Siempre, en todo el país",
    badgeLabel: "Nacional",
    badgeVariant: "success",
    rows: [
      {
        name: "Credencial pública con QR",
        line: "Una página verificable por QR que identifica a tu mascota desde cualquier teléfono.",
      },
      {
        name: "Libreta sanitaria digital",
        line: "Vacunas, controles y eventos clínicos, ordenados e inmutables.",
      },
      {
        name: "Modo perdido con alerta",
        line: "Activás la búsqueda y quien escanea el QR ve cómo avisarte.",
      },
      {
        name: "Compartir libreta con vencimiento",
        line: "Generás un enlace temporal para un veterinario o un cuidador, y caduca solo.",
      },
      {
        name: "Denuncia anónima de maltrato",
        line: "Reportás sin cuenta y seguís el caso con un código.",
      },
      {
        name: "Catálogo de adopción",
        line: "Explorás mascotas en adopción publicadas por organizaciones.",
      },
      {
        name: "Transferencias de custodia",
        line: "El cambio de responsable queda registrado de punta a punta.",
      },
    ],
  },
  {
    id: "localidad",
    title: "Cuando tu localidad se suma",
    badgeLabel: "Según tu localidad",
    badgeVariant: "info",
    rows: [
      {
        name: "Campañas oficiales de vacunación",
        line: "Las vacunaciones masivas cargan sus constancias directo en la libreta.",
      },
      {
        name: "Observación antirrábica gestionada",
        line: "Tras una mordedura, el período se abre, se sigue y se cierra en miMAR.",
      },
      {
        name: "Registro PPP",
        line: "Inscripción de perros potencialmente peligrosos cuando la jurisdicción lo exige.",
      },
      {
        name: "Homologación de la libreta",
        line: "El reconocimiento oficial de la libreta digital como equivalente a la de papel.",
      },
      {
        name: "Casos y moderación local",
        line: "El área municipal gestiona las denuncias y los casos de su territorio.",
      },
      {
        name: "Estadística sanitaria territorial",
        line: "Indicadores agregados de salud animal para la autoridad local.",
      },
    ],
  },
  {
    id: "organizaciones",
    title: "Cuando hay organizaciones cerca",
    badgeLabel: "Según organizaciones",
    badgeVariant: "neutral",
    rows: [
      {
        name: "Turnos con veterinarias",
        line: "Reservás turnos en las clínicas que se sumaron a la red.",
      },
      {
        name: "Vacunas firmadas y verificadas",
        line: "Un profesional con matrícula validada firma el evento en tu libreta.",
      },
      {
        name: "Refugios y custodia",
        line: "Ingreso, permanencia y egreso de animales bajo el cuidado de un refugio.",
      },
      {
        name: "Redes de rescate y tránsitos",
        line: "Coordinación de hogares de tránsito y traslados entre rescatistas.",
      },
    ],
  },
];

function TierRow({ row, tier }: { row: FeatureRow; tier: FeatureTier }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <span className="min-w-0">
        <span className="block text-base font-semibold text-[var(--color-ln-ink)]">{row.name}</span>
        <span className="mt-0.5 block text-sm leading-snug text-[var(--color-ln-mute)]">
          {row.line}
        </span>
      </span>
      <span className="shrink-0 pt-0.5">
        <LnBadge variant={tier.badgeVariant}>{tier.badgeLabel}</LnBadge>
      </span>
    </div>
  );
}

function TierSection({ tier }: { tier: FeatureTier }) {
  return (
    <section aria-labelledby={`${tier.id}-heading`} className="space-y-3">
      <h2 id={`${tier.id}-heading`} className="text-xl font-semibold text-[var(--color-ln-ink)]">
        {tier.title}
      </h2>
      <div className="divide-y divide-[var(--color-ln-line-2)] overflow-hidden rounded-lg border border-[var(--color-ln-line)] bg-[var(--color-ln-card)]">
        {tier.rows.map((row) => (
          <TierRow key={row.name} row={row} tier={tier} />
        ))}
      </div>
    </section>
  );
}

export default function FuncionalidadesPage() {
  return (
    <div className="bg-[var(--color-ln-paper)]">
      <div className="mx-auto max-w-2xl space-y-10 px-6 py-16">
        <header className="space-y-3">
          <h1
            className="text-2xl font-semibold tracking-[-0.015em] leading-tight text-[var(--color-ln-ink)]"
            style={{ fontFamily: "var(--font-ln-serif)" }}
          >
            Qué hace miMAR
          </h1>
          <p className="text-md leading-relaxed text-[var(--color-ln-ink-2)]">
            Todo lo nacional funciona desde el día uno. Lo local se enciende cuando tu localidad y
            sus organizaciones se suman.
          </p>
        </header>

        {TIERS.map((tier) => (
          <TierSection key={tier.id} tier={tier} />
        ))}

        <p
          className="rounded-lg border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-4 py-3 text-sm leading-relaxed text-[var(--color-ln-mute)]"
          role="note"
        >
          La disponibilidad se define jurisdicción por jurisdicción. Consultá con tu municipio.
        </p>

        <Link
          href="/"
          className="inline-block text-md text-[var(--color-ln-azul)] no-underline hover:underline"
        >
          ← Volver al inicio
        </Link>
      </div>
    </div>
  );
}
