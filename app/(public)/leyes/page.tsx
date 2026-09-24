import type { Metadata } from "next";
import Link from "next/link";

import { Icon } from "@/components/Icon";
import {
  LEGAL_KNOWLEDGE_GROUPS,
  type LegalKnowledgeEntry,
  type LegalKnowledgeGroup,
} from "@/lib/reference/legal-knowledge-base";

export const metadata: Metadata = {
  title: "Marco legal — miMAR",
  description:
    "Qué leyes argentinas rigen la tenencia, la salud y el bienestar de tu mascota, explicadas en lenguaje simple.",
};

const JURISDICTION_BADGE_STYLES: Record<LegalKnowledgeEntry["jurisdictionBadge"], string> = {
  Nacional: "border-[var(--color-ln-azul)]/40 text-[var(--color-ln-azul)]",
  CABA: "border-[var(--color-ln-violeta)]/40 text-[var(--color-ln-violeta)]",
  "Buenos Aires": "border-[var(--color-ln-ok)]/40 text-[var(--color-ln-ok)]",
  Internacional: "border-[var(--color-ln-mute)]/40 text-[var(--color-ln-mute)]",
};

function LegalEntryFicha({ entry }: { entry: LegalKnowledgeEntry }) {
  return (
    <details
      id={entry.id}
      className="op-disclosure group rounded-lg border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] open:shadow-sm"
    >
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 px-4 py-3 select-none marker:content-none [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block text-base font-semibold text-[var(--color-ln-ink)]">
            {entry.lawLabel}
          </span>
          <span className="mt-0.5 block text-sm leading-snug text-[var(--color-ln-mute)]">
            {entry.plainMeaning}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 pt-0.5">
          <span
            className={`rounded-full border px-2 py-0.5 text-sm font-medium whitespace-nowrap ${JURISDICTION_BADGE_STYLES[entry.jurisdictionBadge]}`}
          >
            {entry.jurisdictionBadge}
          </span>
          <Icon
            name="chevron-right"
            size="sm"
            decorative
            className="shrink-0 text-[var(--color-ln-mute)] transition-transform duration-150 group-open:rotate-90"
          />
        </span>
      </summary>

      <div className="space-y-3 border-t border-[var(--color-ln-line-2)] px-4 pt-3 pb-4">
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="font-semibold text-[var(--color-ln-ink)]">¿Qué dice?</dt>
            <dd className="leading-relaxed text-[var(--color-ln-ink-2)]">{entry.whatItSays}</dd>
          </div>
          <div>
            <dt className="font-semibold text-[var(--color-ln-ink)]">¿A quién aplica?</dt>
            <dd className="leading-relaxed text-[var(--color-ln-ink-2)]">{entry.whoItAppliesTo}</dd>
          </div>
          <div>
            <dt className="font-semibold text-[var(--color-ln-ink)]">
              ¿Qué obligación implica en miMAR?
            </dt>
            <dd className="leading-relaxed text-[var(--color-ln-ink-2)]">
              {entry.mimarObligation}
            </dd>
          </div>
        </dl>
        <p className="text-xs text-[var(--color-ln-mute)]">
          Fuente:{" "}
          {entry.sourceUrl ? (
            <a
              href={entry.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4 hover:text-[var(--color-ln-azul)]"
            >
              {entry.sourceLabel}
            </a>
          ) : (
            entry.sourceLabel
          )}
        </p>
      </div>
    </details>
  );
}

function LegalGroupSection({ group }: { group: LegalKnowledgeGroup }) {
  return (
    <section aria-labelledby={`${group.id}-heading`} className="space-y-3">
      <div className="space-y-1">
        <h2 id={`${group.id}-heading`} className="text-xl font-semibold text-[var(--color-ln-ink)]">
          {group.title}
        </h2>
        <p className="text-sm leading-relaxed text-[var(--color-ln-mute)]">{group.intro}</p>
      </div>
      <div className="space-y-2">
        {group.entries.map((entry) => (
          <LegalEntryFicha key={entry.id} entry={entry} />
        ))}
      </div>
    </section>
  );
}

export default function LeyesPage() {
  return (
    <div className="bg-[var(--color-ln-paper)]">
      <div className="mx-auto max-w-2xl space-y-10 px-6 py-16">
        <header className="space-y-3">
          <h1
            className="text-2xl font-semibold tracking-[-0.015em] leading-tight text-[var(--color-ln-ink)]"
            style={{ fontFamily: "var(--font-ln-serif)" }}
          >
            Marco legal
          </h1>
          <p className="text-md leading-relaxed text-[var(--color-ln-ink-2)]">
            La tenencia de una mascota en la Argentina no es solo una decisión personal: hay leyes
            nacionales, provinciales y municipales que definen identificación, vacunación, bienestar
            y datos personales. Acá te contamos, en lenguaje simple, qué dice cada norma y cómo se
            refleja en miMAR. Esta página es informativa — no reemplaza el asesoramiento legal ni la
            consulta con la autoridad de tu jurisdicción.
          </p>
        </header>

        <nav aria-label="Temas" className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {LEGAL_KNOWLEDGE_GROUPS.map((group) => (
            <a
              key={group.id}
              href={`#${group.id}-heading`}
              className="text-[var(--color-ln-azul)] no-underline hover:underline"
            >
              {group.title}
            </a>
          ))}
        </nav>

        <div
          className="flex gap-3 rounded-lg border border-[var(--color-ln-celeste-100)] bg-[var(--color-ln-celeste-050)] p-4"
          role="note"
        >
          <Icon
            name="info"
            size="md"
            decorative
            className="mt-0.5 shrink-0 text-[var(--color-ln-azul)]"
          />
          <p className="text-sm leading-relaxed text-[var(--color-ln-ink-2)]">
            <strong>Una mirada urbano-rural:</strong> la hidatidosis —una de las zoonosis
            históricamente vigiladas por norma (ver{" "}
            <a
              href="#zoonosis-heading"
              className="underline underline-offset-4 hover:text-[var(--color-ln-azul)]"
            >
              Zoonosis y salud pública
            </a>
            )— se transmite en el ciclo perro-oveja, típico de zonas de cría rural. Ahí la
            credencial QR de miMAR tiene una ventaja concreta:{" "}
            <strong>se lee desde cualquier teléfono con cámara, sin instalar ninguna app</strong>.
            Quien encuentre al animal escanea el código y accede a los datos básicos de la mascota —
            sin descargar ni configurar nada.
          </p>
        </div>

        {LEGAL_KNOWLEDGE_GROUPS.map((group) => (
          <LegalGroupSection key={group.id} group={group} />
        ))}

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
